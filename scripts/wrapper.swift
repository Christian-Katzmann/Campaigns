// appify native shell — hosts a localhost dev server in a WKWebView so the
// .app bundle owns its window (and therefore its Dock icon, activation, and
// single-instance semantics).
//
// Usage: wrapper <url> [app-name] [port] [pid-file] [polyfill-js-path]
//   url               — http(s) URL to load (typically http://localhost:PORT)
//   app-name          — window title and Dock badge (e.g. "Momó Studio")
//   port              — optional, used by Cmd+Q to sweep stragglers off the dev port
//   pid-file          — optional, path to the daemonized server's pid file.
//                       killServer() ALSO looks for `backend.pid` and
//                       `backend.port` as siblings in the same directory and
//                       cleans them up too — that's how A3.2 multi-server
//                       Cmd+Q tears down the backend without extra argv.
//                       Single-server projects don't have those files; the
//                       sibling pass is a no-op for them.
//   polyfill-js-path  — optional, absolute path to a JS file injected at
//                       document_start. Used to polyfill browser APIs that
//                       WebKit doesn't implement (e.g. File System Access).
//                       The polyfill is the agent's responsibility — see the
//                       skill's `fsa-polyfill-template.js` for a worked
//                       example. Pass an empty string to skip injection.
//
// Build: swiftc -O wrapper.swift -o <out> -framework Cocoa -framework WebKit
//
// WHY THIS EXISTS (read before "improving"):
// Earlier appify revisions used Chrome `--app=URL`. That fails three structural
// requirements at once: (1) the Dock icon shows Chrome's icon while a window is
// open (Chrome owns the window's process tree, not us), (2) clicking the Dock
// icon while running opens a duplicate window because LaunchServices doesn't
// recognize the Chrome process as belonging to our .app, (3) Chrome's profile
// init costs multiple seconds per launch. A native NSWindow + WKWebView fixes
// all three by structure: the .app's identity is the foreground process, so
// macOS keeps showing OUR icon, NSApplication handles single-instance
// activation natively, and WebKit boots in ~200ms.

import Cocoa
import WebKit

private let DEFAULT_WIDTH: CGFloat = 1280
private let DEFAULT_HEIGHT: CGFloat = 820

final class AppDelegate: NSObject,
    NSApplicationDelegate,
    NSWindowDelegate,
    WKNavigationDelegate,
    WKUIDelegate
{
    private let url: URL
    private let appName: String
    private let port: Int?
    private let pidFilePath: String?
    private let polyfillJSPath: String?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var quittingViaWindowClose = false

    init(
        url: URL,
        appName: String,
        port: Int?,
        pidFilePath: String?,
        polyfillJSPath: String?
    ) {
        self.url = url
        self.appName = appName
        self.port = port
        self.pidFilePath = pidFilePath
        self.polyfillJSPath = polyfillJSPath
        super.init()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // Build the macOS menu bar BEFORE the window is shown. Without an
        // explicit NSMenu, AppKit gives us a stub that only handles Cmd+Q.
        // Standard shortcuts (Cmd+W close window, Cmd+M minimize, Cmd+H hide,
        // Cmd+- / Cmd+= / Cmd+0 zoom, Cmd+R reload, Cmd+X/C/V/A edit) need
        // explicit menu items in their respective menus, even when the
        // first-responder default actions exist. Building this once at launch
        // wires up every standard shortcut a user expects from any macOS app.
        buildMenu()

        let frame = NSRect(x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT)

        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = appName
        window.setFrameAutosaveName("AppifyWindow.\(appName)")
        window.tabbingMode = .disallowed
        window.delegate = self
        window.center()

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()

        // AUTOPLAY: public API. On macOS this defaults to [] already, but be
        // explicit. The PRIVATE WKPreferences SPI keys
        // (`requiresUserGestureFor{Media,Video,Audio}Playback`) THROW
        // NSUnknownKeyException on current SDKs and the crash happens in
        // applicationDidFinishLaunching before the window is even constructed —
        // silent black window. DO NOT TOUCH THEM. Real fix is below in
        // synthesizeGesture(): post a synthetic NSEvent click after the first
        // didFinish to give WebKit the platform user-activation it wants.
        config.mediaTypesRequiringUserActionForPlayback = []
        config.allowsAirPlayForMediaPlayback = true
        // Right-click → Inspect Element.
        config.preferences.setValue(true, forKey: "developerExtrasEnabled")

        // Optional polyfill injection. The agent ships a per-project JS file
        // (e.g. an FSA shim for apps that call showDirectoryPicker) and passes
        // its absolute path via argv. We load and inject at document_start.
        if let path = polyfillJSPath,
           !path.isEmpty,
           let polyfill = try? String(contentsOfFile: path, encoding: .utf8)
        {
            let userScript = WKUserScript(
                source: polyfill,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            config.userContentController.addUserScript(userScript)
        }

        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView

        webView.load(URLRequest(url: url))
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private var hasSynthesizedGesture = false

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // WebKit treats the first user click as the platform user-activation
        // that unlocks programmatic media playback. Posting a synthetic
        // NSEvent mouseDown/mouseUp pair counts as a real gesture (unlike
        // dispatchEvent's synthetic events from JS, which don't). Do this
        // exactly once, at a coordinate inside the dark titlebar/header strip
        // where there is no clickable HTML, so the click can't trigger any UI.
        if !hasSynthesizedGesture {
            hasSynthesizedGesture = true
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) { [weak self] in
                self?.synthesizeGesture()
            }
        }
    }

    private func synthesizeGesture() {
        guard let window = window else { return }
        let location = NSPoint(x: 5, y: 5)  // top-left, inside the WKWebView frame
        guard
            let down = NSEvent.mouseEvent(
                with: .leftMouseDown,
                location: location,
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: 0,
                clickCount: 1,
                pressure: 1.0
            ),
            let up = NSEvent.mouseEvent(
                with: .leftMouseUp,
                location: location,
                modifierFlags: [],
                timestamp: ProcessInfo.processInfo.systemUptime,
                windowNumber: window.windowNumber,
                context: nil,
                eventNumber: 0,
                clickCount: 1,
                pressure: 0.0
            )
        else { return }
        webView.mouseDown(with: down)
        webView.mouseUp(with: up)
        // The page may have already called play() before the gesture
        // arrived — kick it again now that we have user activation.
        webView.evaluateJavaScript(
            """
            (function () {
              var v = document.querySelector('video');
              if (v) { try { v.play().catch(function(){}); } catch(_) {} }
            })()
            """
        )
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
        true
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        // Distinguish red-X close from Cmd+Q. Red-X = leave server warm
        // (daemon-mode); Cmd+Q = full shutdown including the dev server.
        quittingViaWindowClose = true
        return true
    }

    func applicationShouldTerminate(_ sender: NSApplication) -> NSApplication.TerminateReply {
        if !quittingViaWindowClose {
            killServer()
        }
        return .terminateNow
    }

    func applicationShouldHandleReopen(
        _ sender: NSApplication,
        hasVisibleWindows flag: Bool
    ) -> Bool {
        if !flag, let window = window {
            window.makeKeyAndOrderFront(nil)
        }
        return true
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping (WKNavigationActionPolicy) -> Void
    ) {
        guard let target = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        // External links open in the user's default browser, not in the .app
        // window. Anything localhost stays in-window.
        if let host = target.host,
            host != "localhost",
            host != "127.0.0.1",
            !host.hasSuffix(".localhost")
        {
            NSWorkspace.shared.open(target)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(
        _ webView: WKWebView,
        runJavaScriptAlertPanelWithMessage message: String,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping () -> Void
    ) {
        let alert = NSAlert()
        alert.messageText = appName
        alert.informativeText = message
        alert.runModal()
        completionHandler()
    }

    private func killServer() {
        // Frontend (or single-server) — recorded PID + argv port.
        terminatePid(fromFile: pidFilePath, removeFile: true)
        if let p = port {
            sweepPort(p)
        }

        // Multi-server sibling discovery. The multiserver run-template only
        // passes `server.pid` and the FE port to wrapper, so without this
        // pass the backend leaks past Cmd+Q. Look in the same directory as
        // pidFilePath for `backend.pid` / `backend.port` and clean them up.
        // Backward-compatible: single-server projects won't have these files.
        guard let pidPath = pidFilePath else { return }
        let logDir = (pidPath as NSString).deletingLastPathComponent
        let backendPidPath = (logDir as NSString).appendingPathComponent("backend.pid")
        let backendPortPath = (logDir as NSString).appendingPathComponent("backend.port")
        terminatePid(fromFile: backendPidPath, removeFile: true)
        if let raw = try? String(contentsOfFile: backendPortPath, encoding: .utf8),
            let bport = Int(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
            bport > 0
        {
            sweepPort(bport)
            // Don't remove backend.port — symmetric with how the existing
            // FE branch leaves server.port intact. desktop-quit.sh and the
            // launcher's stale-state cleanup handle port-file lifecycle.
        }
    }

    private func terminatePid(fromFile path: String?, removeFile: Bool) {
        guard let path = path,
            let raw = try? String(contentsOfFile: path, encoding: .utf8),
            let pid = Int32(raw.trimmingCharacters(in: .whitespacesAndNewlines)),
            pid > 1
        else { return }
        kill(pid, SIGTERM)
        if removeFile {
            try? FileManager.default.removeItem(atPath: path)
        }
    }

    private func sweepPort(_ p: Int) {
        let task = Process()
        task.executableURL = URL(fileURLWithPath: "/bin/sh")
        task.arguments = [
            "-c",
            "for q in $(/usr/sbin/lsof -ti tcp:\(p) 2>/dev/null); do /bin/kill -TERM $q 2>/dev/null; done",
        ]
        try? task.run()
        task.waitUntilExit()
    }

    // MARK: - Menu bar

    private func buildMenu() {
        let mainMenu = NSMenu()

        // App menu — About, Hide, Quit. Quit (Cmd+Q) is what the AppKit stub
        // gives us by default; the rest only work when explicitly added.
        let appMenuItem = NSMenuItem()
        let appMenu = NSMenu()
        appMenu.addItem(
            withTitle: "About \(appName)",
            action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(
            withTitle: "Hide \(appName)",
            action: #selector(NSApplication.hide(_:)),
            keyEquivalent: "h"
        )
        let hideOthers = appMenu.addItem(
            withTitle: "Hide Others",
            action: #selector(NSApplication.hideOtherApplications(_:)),
            keyEquivalent: "h"
        )
        hideOthers.keyEquivalentModifierMask = [.command, .option]
        appMenu.addItem(
            withTitle: "Show All",
            action: #selector(NSApplication.unhideAllApplications(_:)),
            keyEquivalent: ""
        )
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(
            withTitle: "Quit \(appName)",
            action: #selector(NSApplication.terminate(_:)),
            keyEquivalent: "q"
        )
        appMenuItem.submenu = appMenu
        mainMenu.addItem(appMenuItem)

        // Edit menu — first-responder default actions. Pass nil-targeted
        // selectors and AppKit routes them to the focused control. WKWebView
        // implements all of these for selected text inputs.
        let editMenuItem = NSMenuItem()
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        let redoItem = editMenu.addItem(
            withTitle: "Redo",
            action: Selector(("redo:")),
            keyEquivalent: "Z"
        )
        redoItem.keyEquivalentModifierMask = [.command, .shift]
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(
            withTitle: "Select All",
            action: #selector(NSText.selectAll(_:)),
            keyEquivalent: "a"
        )
        editMenuItem.submenu = editMenu
        mainMenu.addItem(editMenuItem)

        // View menu — zoom and reload, custom actions on the AppDelegate.
        // Cmd+- / Cmd+= / Cmd+0 are what users press without thinking.
        let viewMenuItem = NSMenuItem()
        let viewMenu = NSMenu(title: "View")
        viewMenu.addItem(
            withTitle: "Reload",
            action: #selector(reloadPage),
            keyEquivalent: "r"
        )
        let forceReload = viewMenu.addItem(
            withTitle: "Force Reload",
            action: #selector(reloadPageIgnoringCache),
            keyEquivalent: "R"
        )
        forceReload.keyEquivalentModifierMask = [.command, .shift]
        viewMenu.addItem(NSMenuItem.separator())
        viewMenu.addItem(
            withTitle: "Actual Size",
            action: #selector(resetZoom),
            keyEquivalent: "0"
        )
        viewMenu.addItem(
            withTitle: "Zoom In",
            action: #selector(zoomIn),
            keyEquivalent: "="
        )
        viewMenu.addItem(
            withTitle: "Zoom Out",
            action: #selector(zoomOut),
            keyEquivalent: "-"
        )
        viewMenu.addItem(NSMenuItem.separator())
        let fullScreen = viewMenu.addItem(
            withTitle: "Toggle Full Screen",
            action: #selector(NSWindow.toggleFullScreen(_:)),
            keyEquivalent: "f"
        )
        fullScreen.keyEquivalentModifierMask = [.command, .control]
        viewMenuItem.submenu = viewMenu
        mainMenu.addItem(viewMenuItem)

        // Window menu — Minimize, Close, Bring All to Front. AppKit treats
        // any submenu set as windowsMenu specially (auto-tracks open windows).
        let windowMenuItem = NSMenuItem()
        let windowMenu = NSMenu(title: "Window")
        windowMenu.addItem(
            withTitle: "Minimize",
            action: #selector(NSWindow.performMiniaturize(_:)),
            keyEquivalent: "m"
        )
        windowMenu.addItem(
            withTitle: "Close Window",
            action: #selector(NSWindow.performClose(_:)),
            keyEquivalent: "w"
        )
        windowMenu.addItem(NSMenuItem.separator())
        windowMenu.addItem(
            withTitle: "Bring All to Front",
            action: #selector(NSApplication.arrangeInFront(_:)),
            keyEquivalent: ""
        )
        windowMenuItem.submenu = windowMenu
        mainMenu.addItem(windowMenuItem)
        NSApp.windowsMenu = windowMenu

        NSApp.mainMenu = mainMenu
    }

    @objc private func zoomIn() {
        guard let webView = webView else { return }
        webView.pageZoom *= 1.1
    }

    @objc private func zoomOut() {
        guard let webView = webView else { return }
        webView.pageZoom /= 1.1
    }

    @objc private func resetZoom() {
        guard let webView = webView else { return }
        webView.pageZoom = 1.0
    }

    @objc private func reloadPage() {
        webView?.reload()
    }

    @objc private func reloadPageIgnoringCache() {
        webView?.reloadFromOrigin()
    }
}

let arguments = CommandLine.arguments
guard arguments.count >= 2, let url = URL(string: arguments[1]) else {
    FileHandle.standardError.write(
        Data("usage: wrapper <url> [app-name] [port] [pid-file] [polyfill-js-path]\n".utf8))
    exit(2)
}
let appName = arguments.count >= 3 ? arguments[2] : "App"
let port = arguments.count >= 4 ? Int(arguments[3]) : nil
let pidFilePath = arguments.count >= 5 && !arguments[4].isEmpty ? arguments[4] : nil
let polyfillJSPath = arguments.count >= 6 && !arguments[5].isEmpty ? arguments[5] : nil

let app = NSApplication.shared
let delegate = AppDelegate(
    url: url,
    appName: appName,
    port: port,
    pidFilePath: pidFilePath,
    polyfillJSPath: polyfillJSPath
)
app.delegate = delegate
app.setActivationPolicy(.regular)
app.run()
