// app-it native shell — hosts a localhost dev server in a WKWebView so the
// .app bundle owns its window (and therefore its Dock icon, activation, and
// single-instance semantics).
//
// Usage: wrapper <url> [app-name] [port] [pid-file] [polyfill-js-path] [companion-path] [launch-mode]
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
//   companion-path    — optional. When set (e.g. "/companion"), the wrapper
//                       exposes a `window.campaignCompanion` JS bridge in the
//                       main window and, on request, opens a small floating
//                       NSPanel pointed at <base-origin><companion-path>. The
//                       panel rides on the SAME dev server — no second server
//                       is launched — and stays visible across Spaces and apps
//                       without stealing key focus. Empty/absent disables the
//                       bridge entirely, so generic app-it apps are unaffected.
//   launch-mode       — optional. Use "menu-bar" to start hidden with only the
//                       menu-bar item visible. The main window can still be
//                       opened from the companion's Open App button.
//
// Build: swiftc -O wrapper.swift -o <out> -framework Cocoa -framework WebKit
//
// WHY THIS EXISTS (read before "improving"):
// Earlier app-it revisions used Chrome `--app=URL`. That fails three structural
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
private let MIN_WIDTH: CGFloat = 720
private let MIN_HEIGHT: CGFloat = 480
private let COMPANION_EXPANDED_SIZE = NSSize(width: 360, height: 520)
private let COMPANION_COLLAPSED_SIZE = NSSize(width: 82, height: 92)
private let COMPANION_EXPANDED_MIN_SIZE = NSSize(width: 300, height: 380)
private let COMPANION_PET_CELL_WIDTH = 192
private let COMPANION_PET_CELL_HEIGHT = 208

private enum CompanionPetAnimation: Hashable {
    case idle
    case running
    case waving
}

final class AppDelegate: NSObject,
    NSApplicationDelegate,
    NSWindowDelegate,
    WKNavigationDelegate,
    WKUIDelegate,
    WKScriptMessageHandler
{
    private let url: URL
    private let appName: String
    private let port: Int?
    private let pidFilePath: String?
    private let polyfillJSPath: String?
    private let companionPath: String?
    private let launchMode: String?
    private var window: NSWindow!
    private var webView: WKWebView!
    private var quittingViaWindowClose = false
    private var keyMonitor: Any?
    private var findBar: FindBar?
    private var lastFindQuery = ""
    private var companionPanel: NSPanel?
    private var companionWebView: WKWebView?
    private var companionStatusItem: NSStatusItem?
    private var companionExpandedFrame: NSRect?
    private var companionIsCollapsed = false
    private var companionDragView: CompanionDragView?
    private var companionBadgeCount = 0

    init(
        url: URL,
        appName: String,
        port: Int?,
        pidFilePath: String?,
        polyfillJSPath: String?,
        companionPath: String?,
        launchMode: String?
    ) {
        self.url = url
        self.appName = appName
        self.port = port
        self.pidFilePath = pidFilePath
        self.polyfillJSPath = polyfillJSPath
        self.companionPath = companionPath
        self.launchMode = launchMode
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
        installCompanionStatusItem()
        installKeyboardShortcutMonitor()

        let frame = NSRect(x: 0, y: 0, width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT)
        let autosaveName = "App-itWindow.\(appName)"

        window = NSWindow(
            contentRect: frame,
            styleMask: [.titled, .closable, .miniaturizable, .resizable, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        window.title = appName
        window.isReleasedWhenClosed = false
        window.setFrameAutosaveName(autosaveName)
        window.minSize = NSSize(width: MIN_WIDTH, height: MIN_HEIGHT)
        window.tabbingMode = .disallowed
        window.delegate = self
        restoreUsableWindowFrame(named: autosaveName)

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

        // Companion bridge. Only wired when a companion path was passed, so a
        // generic app-it app never gets the `window.campaignCompanion` global
        // or the message handler. The page-side launch control (app.js
        // launchCompanion) feature-detects this bridge and delegates to it
        // instead of opening a browser popup.
        if companionPath != nil {
            config.userContentController.add(self, name: "campaignCompanion")
            let bridge = WKUserScript(
                source: Self.companionBridgeJS,
                injectionTime: .atDocumentStart,
                forMainFrameOnly: true
            )
            config.userContentController.addUserScript(bridge)
        }

        webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.autoresizingMask = [.width, .height]
        window.contentView = webView

        webView.load(URLRequest(url: url))
        if launchMode == "menu-bar" && companionPath != nil {
            NSApp.setActivationPolicy(.accessory)
        } else {
            showMainWindow()
        }
    }

    private func restoreUsableWindowFrame(named autosaveName: String) {
        // AppKit can restore a frame saved on a now-disconnected display, or a
        // tiny frame saved before the WebKit shell had a minimum size. Clamp
        // the restored frame into a visible screen before the first paint so
        // the WKWebView opens usable instead of off-screen or postage-stamp.
        if !window.setFrameUsingName(autosaveName) {
            window.center()
        }

        guard let screen = bestScreen(for: window.frame) else { return }
        var frame = window.frame
        let visible = screen.visibleFrame

        frame.size.width = min(max(frame.size.width, MIN_WIDTH), visible.width)
        frame.size.height = min(max(frame.size.height, MIN_HEIGHT), visible.height)

        if frame.maxX > visible.maxX {
            frame.origin.x = visible.maxX - frame.size.width
        }
        if frame.minX < visible.minX {
            frame.origin.x = visible.minX
        }
        if frame.maxY > visible.maxY {
            frame.origin.y = visible.maxY - frame.size.height
        }
        if frame.minY < visible.minY {
            frame.origin.y = visible.minY
        }

        window.setFrame(frame, display: false)
    }

    private func bestScreen(for frame: NSRect) -> NSScreen? {
        // When a frame straddles two displays, the first intersecting screen is
        // arbitrary. Pick the screen holding the largest slice of the frame, and
        // only fall back to main/first when nothing intersects at all.
        var best: NSScreen?
        var largestArea: CGFloat = 0
        for screen in NSScreen.screens {
            let overlap = screen.visibleFrame.intersection(frame)
            guard !overlap.isNull else { continue }
            let area = overlap.width * overlap.height
            if area > largestArea {
                largestArea = area
                best = screen
            }
        }
        return best ?? NSScreen.main ?? NSScreen.screens.first
    }

    private var hasSynthesizedGesture = false

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        // The companion panel shares this navigation delegate (for the
        // external-link policy below). The gesture synthesis is a main-window
        // media-autoplay unlock — irrelevant to the companion — so skip it for
        // any web view that isn't the main one.
        guard webView === self.webView else { return }
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
        companionPath == nil
    }

    func windowShouldClose(_ sender: NSWindow) -> Bool {
        if companionPath != nil, sender === window {
            window.orderOut(nil)
            return false
        }
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
        if !flag {
            showMainWindow()
        }
        return true
    }

    func windowDidResize(_ notification: Notification) {
        if let bar = findBar, !bar.isHidden {
            bar.frame = FindBar.frame(inView: webView)
        }
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

    // WKWebView won't open a native file picker for <input type="file"> unless
    // the host explicitly implements this WKUIDelegate method. Without it,
    // every file input in the embedded web app silently does nothing on
    // click — looks like the button is dead. Bridge to NSOpenPanel so
    // single-file and multi-file pickers both work natively.
    func webView(
        _ webView: WKWebView,
        runOpenPanelWith parameters: WKOpenPanelParameters,
        initiatedByFrame frame: WKFrameInfo,
        completionHandler: @escaping ([URL]?) -> Void
    ) {
        let panel = NSOpenPanel()
        panel.canChooseFiles = true
        panel.canChooseDirectories = false
        panel.allowsMultipleSelection = parameters.allowsMultipleSelection
        panel.begin { response in
            if response == .OK {
                completionHandler(panel.urls)
            } else {
                completionHandler(nil)
            }
        }
    }

    // MARK: - Companion panel

    private func installCompanionStatusItem() {
        guard companionPath != nil else { return }
        let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        companionStatusItem = item
        guard let button = item.button else { return }
        if let image = NSImage(
            systemSymbolName: "rectangle.split.2x1",
            accessibilityDescription: "Campaign Companion"
        ) {
            image.isTemplate = true
            button.image = image
            button.imagePosition = .imageOnly
        } else {
            button.title = "C"
        }
        button.toolTip = "Campaign Companion"
        button.target = self
        button.action = #selector(companionStatusItemTapped)
    }

    @objc private func companionStatusItemTapped(_ sender: Any?) {
        toggleCompanionPanel()
    }

    // JS injected into the main window. Mirrors the bridge shape app.js
    // feature-detects: `window.campaignCompanion.open()`. close()/toggle() are
    // provided for symmetry and future use. Wrapped in try/catch so a missing
    // message handler can never throw into page code.
    private static let companionBridgeJS = """
    (function () {
      function send(action, payload) {
        try {
          window.webkit.messageHandlers.campaignCompanion.postMessage(Object.assign({ action: action }, payload || {}));
        } catch (e) {}
      }
      window.campaignCompanion = {
        open:         function () { send('open');   },
        close:        function () { send('close');  },
        toggle:       function () { send('toggle'); },
        openApp:      function () { send('openApp'); },
        setCollapsed: function (collapsed) { send('setCollapsed', { collapsed: !!collapsed }); },
        setBadgeCount:function (count) { send('setBadgeCount', { count: Number(count) || 0 }); },
        setPetActive: function (active) { send('setPetActive', { active: !!active }); },
      };
    })();
    """

    // Resolves the companion page URL against the main window's origin so the
    // panel rides the SAME dev server. Accepts an absolute path ("/companion")
    // or a full URL; falls back to nil when no companion path was configured.
    private func resolveCompanionURL() -> URL? {
        guard let path = companionPath, !path.isEmpty else { return nil }
        if let full = URL(string: path), full.scheme != nil { return full }
        guard var comps = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        comps.path = path.hasPrefix("/") ? path : "/" + path
        comps.query = nil
        comps.fragment = nil
        return comps.url
    }

    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage
    ) {
        guard message.name == "campaignCompanion" else { return }
        let body = message.body as? [String: Any]
        let action = body?["action"] as? String ?? "open"
        switch action {
        case "close":        companionPanel?.orderOut(nil)
        case "toggle":       toggleCompanionPanel()
        case "openApp":      showMainWindow()
        case "setCollapsed": setCompanionPanelCollapsed((body?["collapsed"] as? Bool) ?? false)
        case "setBadgeCount":
            companionBadgeCount = body?["count"] as? Int ?? 0
            companionDragView?.badgeCount = companionBadgeCount
        case "setPetActive":
            companionDragView?.petActive = (body?["active"] as? Bool) ?? false
        default:             showCompanionPanel()
        }
    }

    private func showMainWindow() {
        NSApp.setActivationPolicy(.regular)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    private func toggleCompanionPanel() {
        if let panel = companionPanel, panel.isVisible {
            panel.orderOut(nil)
        } else {
            showCompanionPanel()
        }
    }

    private func showCompanionPanel() {
        guard let companionURL = resolveCompanionURL() else { return }
        let panel = companionPanel ?? makeCompanionPanel(loading: companionURL)
        companionPanel = panel
        positionCompanionPanel(panel)
        // orderFrontRegardless shows the panel WITHOUT activating the app or
        // taking key focus — the user keeps typing wherever they were. Combined
        // with the .nonactivatingPanel style mask, even clicking the panel
        // later won't steal focus from the foreground app.
        panel.orderFrontRegardless()
    }

    private func makeCompanionPanel(loading companionURL: URL) -> NSPanel {
        let panel = NSPanel(
            contentRect: NSRect(origin: .zero, size: COMPANION_EXPANDED_SIZE),
            styleMask: [.titled, .closable, .resizable, .utilityWindow,
                        .nonactivatingPanel, .fullSizeContentView],
            backing: .buffered,
            defer: false
        )
        panel.title = "\(appName) Companion"
        configureCompanionPanel(panel, collapsed: false)

        let config = WKWebViewConfiguration()
        config.websiteDataStore = .default()
        config.userContentController.add(self, name: "campaignCompanion")
        config.userContentController.addUserScript(WKUserScript(
            source: Self.companionBridgeJS,
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        ))

        let host = NSView(frame: NSRect(origin: .zero, size: COMPANION_EXPANDED_SIZE))
        host.autoresizingMask = [.width, .height]
        host.wantsLayer = true
        host.layer?.backgroundColor = NSColor.clear.cgColor

        let companionView = WKWebView(frame: NSRect(origin: .zero, size: COMPANION_EXPANDED_SIZE), configuration: config)
        companionView.navigationDelegate = self  // reuse external-link policy
        companionView.autoresizingMask = [.width, .height]
        companionView.wantsLayer = true
        companionView.layer?.backgroundColor = NSColor.clear.cgColor
        companionView.layer?.isOpaque = false
        if companionView.responds(to: Selector(("setDrawsBackground:"))) {
            companionView.setValue(false, forKey: "drawsBackground")
        }
        if #available(macOS 12.0, *) {
            companionView.underPageBackgroundColor = .clear
        }

        let dragView = CompanionDragView(frame: host.bounds)
        dragView.autoresizingMask = [.width, .height]
        dragView.panel = panel
        dragView.petAnimations = loadCollapsedPetAnimations()
        dragView.badgeCount = companionBadgeCount
        dragView.onExpand = { [weak self] in
            self?.companionWebView?.evaluateJavaScript("window.campaignCompanionSetCollapsedFromNative && window.campaignCompanionSetCollapsedFromNative(false);")
            self?.setCompanionPanelCollapsed(false)
        }
        dragView.isHidden = true

        host.addSubview(companionView)
        host.addSubview(dragView)
        panel.contentView = host
        companionView.load(URLRequest(url: companionURL))
        companionWebView = companionView
        companionDragView = dragView
        return panel
    }

    private func setCompanionPanelCollapsed(_ collapsed: Bool) {
        guard let panel = companionPanel else { return }
        guard companionIsCollapsed != collapsed else { return }
        companionIsCollapsed = collapsed

        if collapsed {
            companionExpandedFrame = panel.frame
            configureCompanionPanel(panel, collapsed: true)
            companionWebView?.isHidden = true
            companionDragView?.isHidden = false
            companionDragView?.startAnimation()
            panel.minSize = COMPANION_COLLAPSED_SIZE
            resizeCompanionPanel(panel, to: COMPANION_COLLAPSED_SIZE)
        } else {
            let current = panel.frame
            let target = companionExpandedFrame ?? NSRect(
                x: current.maxX - COMPANION_EXPANDED_SIZE.width,
                y: current.maxY - COMPANION_EXPANDED_SIZE.height,
                width: COMPANION_EXPANDED_SIZE.width,
                height: COMPANION_EXPANDED_SIZE.height
            )
            configureCompanionPanel(panel, collapsed: false)
            companionWebView?.isHidden = false
            companionDragView?.isHidden = true
            companionDragView?.stopAnimation()
            panel.setFrame(target, display: true, animate: true)
            panel.minSize = COMPANION_EXPANDED_MIN_SIZE
        }
    }

    private func loadCollapsedPetAnimations() -> [CompanionPetAnimation: [NSImage]] {
        let fm = FileManager.default
        let home = fm.homeDirectoryForCurrentUser.path
        let codexHome = ProcessInfo.processInfo.environment["CODEX_HOME"] ?? "\(home)/.codex"
        let petId = ProcessInfo.processInfo.environment["CAMPAIGNS_COMPANION_PET"] ?? "kro"
        let spritesheet = "\(codexHome)/pets/\(petId)/spritesheet.webp"
        guard let sheet = NSImage(contentsOfFile: spritesheet),
              let cg = sheet.cgImage(forProposedRect: nil, context: nil, hints: nil)
        else { return [:] }

        let rows: [(CompanionPetAnimation, Int, Int)] = [
            (.idle, 0, 6),
            (.running, 7, 6),
            (.waving, 3, 4),
        ]
        var animations: [CompanionPetAnimation: [NSImage]] = [:]
        for (state, row, frameCount) in rows {
            var frames: [NSImage] = []
            for index in 0..<frameCount {
                let cropRect = CGRect(
                    x: CGFloat(index * COMPANION_PET_CELL_WIDTH),
                    y: CGFloat(cg.height - ((row + 1) * COMPANION_PET_CELL_HEIGHT)),
                    width: CGFloat(COMPANION_PET_CELL_WIDTH),
                    height: CGFloat(COMPANION_PET_CELL_HEIGHT)
                )
                guard let cropped = cg.cropping(to: cropRect) else { continue }
                frames.append(NSImage(
                    cgImage: cropped,
                    size: NSSize(
                        width: CGFloat(COMPANION_PET_CELL_WIDTH),
                        height: CGFloat(COMPANION_PET_CELL_HEIGHT)
                    )
                ))
            }
            animations[state] = frames
        }
        return animations
    }

    private func configureCompanionPanel(_ panel: NSPanel, collapsed: Bool) {
        if collapsed {
            panel.styleMask = [.borderless, .nonactivatingPanel]
            panel.backgroundColor = .clear
            panel.isOpaque = false
            panel.hasShadow = false
            panel.isMovableByWindowBackground = false
        } else {
            panel.styleMask = [.titled, .closable, .resizable, .utilityWindow,
                               .nonactivatingPanel, .fullSizeContentView]
            panel.titlebarAppearsTransparent = true
            panel.titleVisibility = .hidden
            panel.backgroundColor = .windowBackgroundColor
            panel.isOpaque = false
            panel.hasShadow = true
            panel.isMovableByWindowBackground = false
            panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
            panel.standardWindowButton(.zoomButton)?.isHidden = true
        }

        panel.isFloatingPanel = true
        panel.level = .floating
        panel.hidesOnDeactivate = false
        panel.isReleasedWhenClosed = false
        panel.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .stationary]
    }

    private func resizeCompanionPanel(_ panel: NSPanel, to size: NSSize) {
        let current = panel.frame
        let target = NSRect(
            x: current.maxX - size.width,
            y: current.maxY - size.height,
            width: size.width,
            height: size.height
        )
        panel.setFrame(target, display: true, animate: true)
    }

    private func positionCompanionPanel(_ panel: NSPanel) {
        // Only auto-place the first time it's shown; respect the user's drag
        // afterwards. Anchor to the top-right of the main window's screen.
        guard !panel.isVisible else { return }
        let screen = bestScreen(for: window?.frame ?? panel.frame) ?? NSScreen.main
        guard let visible = screen?.visibleFrame else { panel.center(); return }
        let margin: CGFloat = 24
        let origin = NSPoint(
            x: visible.maxX - panel.frame.width - margin,
            y: visible.maxY - panel.frame.height - margin
        )
        panel.setFrameOrigin(origin)
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

    // MARK: - Find in page

    private func toggleFindBar() {
        if let bar = findBar, !bar.isHidden {
            hideFindBar()
        } else {
            showFindBar()
        }
    }

    private func showFindBar() {
        let bar: FindBar
        if let existing = findBar {
            bar = existing
        } else {
            bar = FindBar()
            bar.onQueryChange = { [weak self] q in self?.performFind(q, forward: true) }
            bar.onNext       = { [weak self] in  self?.navigateFind(forward: true)  }
            bar.onPrev       = { [weak self] in  self?.navigateFind(forward: false) }
            bar.onClose      = { [weak self] in  self?.hideFindBar()                }
            webView.addSubview(bar)
            findBar = bar
        }
        bar.frame = FindBar.frame(inView: webView)
        bar.alphaValue = 0
        bar.isHidden = false
        NSAnimationContext.runAnimationGroup { ctx in
            ctx.duration = 0.15
            ctx.timingFunction = CAMediaTimingFunction(name: .easeOut)
            bar.animator().alphaValue = 1
        }
        window.makeFirstResponder(bar.searchField)
        // Re-run the last query so matches are immediately highlighted on re-open.
        if !lastFindQuery.isEmpty {
            bar.searchField.stringValue = lastFindQuery
            performFind(lastFindQuery, forward: true)
        }
    }

    private func hideFindBar() {
        guard let bar = findBar, !bar.isHidden else { return }
        NSAnimationContext.runAnimationGroup({ ctx in
            ctx.duration = 0.12
            bar.animator().alphaValue = 0
        }) { bar.isHidden = true }
        window.makeFirstResponder(webView)
        // Clear WebKit's find highlight by searching for an empty string.
        if #available(macOS 12.0, *) {
            webView.find("", configuration: WKFindConfiguration()) { _ in }
        }
    }

    private func performFind(_ query: String, forward: Bool) {
        lastFindQuery = query
        guard !query.isEmpty else { findBar?.setStatus(""); return }
        if #available(macOS 12.0, *) {
            let cfg = WKFindConfiguration()
            cfg.backwards = !forward
            cfg.wraps = true
            webView.find(query, configuration: cfg) { [weak self] result in
                self?.updateMatchCount(for: query, matchFound: result.matchFound)
            }
        }
    }

    private func navigateFind(forward: Bool) {
        performFind(lastFindQuery, forward: forward)
    }

    private func updateMatchCount(for query: String, matchFound: Bool) {
        guard !query.isEmpty else { return }
        guard matchFound else { findBar?.setStatus("Not found", isError: true); return }
        // WKFindResult only tells us a match was found, not the total count.
        // Walk the DOM via JS to get the total and show it in the bar.
        let safe = query
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        let js = """
        (function(){
          try{
            var re=new RegExp('\(safe)'.replace(/[.*+?^${}()|[\\]\\\\]/g,'\\\\$&'),'gi');
            var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT);
            var n=0,node;
            while((node=w.nextNode())){var m=node.nodeValue.match(re);if(m)n+=m.length;}
            return n;
          }catch(e){return -1;}
        })()
        """
        webView.evaluateJavaScript(js) { [weak self] res, _ in
            DispatchQueue.main.async {
                let n = res as? Int ?? 0
                self?.findBar?.setStatus(
                    n > 1 ? "\(n) matches" : (n == 1 ? "1 match" : "Found")
                )
            }
        }
    }

    // MARK: - Keyboard shortcut monitor

    // WKWebView intercepts Cmd+= (zoom in) and Cmd+R (reload) in some page
    // contexts before AppKit's menu key-equivalent check fires. A local event
    // monitor runs earlier in the event chain and lets us consume these
    // shortcuts reliably, returning nil so the webview never sees them.
    // The menu items still exist for discoverability — they just don't fire
    // via the normal key-equivalent path for these shortcuts.
    private func installKeyboardShortcutMonitor() {
        keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
            guard let self else { return event }
            let mods = event.modifierFlags.intersection([.command, .shift, .option, .control])
            guard mods.contains(.command),
                  !mods.contains(.option),
                  !mods.contains(.control) else { return event }
            let chars = event.charactersIgnoringModifiers ?? ""
            let shift = mods.contains(.shift)
            switch (chars, shift) {
            case ("=", _), ("+", _): self.zoomIn();                  return nil  // Cmd+= or Cmd++
            case ("-", false):        self.zoomOut();                 return nil
            case ("0", false):        self.resetZoom();               return nil
            case ("r", false):        self.reloadPage();              return nil
            case ("r", true):         self.reloadPageIgnoringCache(); return nil
            case ("f", false):        self.toggleFindBar();           return nil
            default:                  return event
            }
        }
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

// MARK: - FindBar

final class CompanionDragView: NSView {
    weak var panel: NSPanel?
    var onExpand: (() -> Void)?
    fileprivate var petAnimations: [CompanionPetAnimation: [NSImage]] = [:] {
        didSet {
            animationState = .idle
            frameIndex = 0
            needsDisplay = true
        }
    }
    var badgeCount: Int = 0 {
        didSet {
            needsDisplay = true
        }
    }
    var petActive: Bool = false {
        didSet {
            updateAnimationState(resetFrame: false)
        }
    }

    private var dragStartMouse = NSPoint.zero
    private var dragStartOrigin = NSPoint.zero
    private var didDrag = false
    private var animationTimer: Timer?
    private var animationState: CompanionPetAnimation = .idle
    private var isHovering = false
    private var frameIndex = 0

    override var acceptsFirstResponder: Bool { true }
    override var isOpaque: Bool { false }

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        for area in trackingAreas {
            removeTrackingArea(area)
        }
        addTrackingArea(NSTrackingArea(
            rect: bounds,
            options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
            owner: self,
            userInfo: nil
        ))
    }

    func startAnimation() {
        stopAnimation()
        updateAnimationState(resetFrame: true)
        scheduleNextFrame()
    }

    func stopAnimation() {
        animationTimer?.invalidate()
        animationTimer = nil
    }

    private func updateAnimationState(resetFrame: Bool) {
        let nextState: CompanionPetAnimation = isHovering ? .waving : (petActive ? .running : .idle)
        if nextState != animationState || resetFrame {
            animationState = nextState
            frameIndex = 0
            needsDisplay = true
        }
        if animationTimer != nil {
            scheduleNextFrame()
        }
    }

    private func scheduleNextFrame() {
        animationTimer?.invalidate()
        let frames = currentFrames()
        guard frames.count > 1 else { return }
        animationTimer = Timer.scheduledTimer(withTimeInterval: currentFrameDuration(), repeats: false) {
            [weak self] _ in
            guard let self else { return }
            let frames = self.currentFrames()
            guard !frames.isEmpty else { return }
            self.frameIndex = (self.frameIndex + 1) % frames.count
            self.needsDisplay = true
            self.scheduleNextFrame()
        }
    }

    private func currentFrames() -> [NSImage] {
        if let frames = petAnimations[animationState], !frames.isEmpty {
            return frames
        }
        if let idle = petAnimations[.idle], !idle.isEmpty {
            return idle
        }
        return petAnimations.values.first ?? []
    }

    private func currentFrameDuration() -> TimeInterval {
        let durations: [TimeInterval]
        switch animationState {
        case .idle:
            durations = [0.28, 0.11, 0.11, 0.14, 0.14, 0.32]
        case .running:
            durations = [0.12, 0.12, 0.12, 0.12, 0.12, 0.22]
        case .waving:
            durations = [0.14, 0.14, 0.14, 0.28]
        }
        return durations[min(frameIndex, durations.count - 1)]
    }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.clear.setFill()
        dirtyRect.fill()

        let petRect = bounds.insetBy(dx: 7, dy: 4)
        let frames = currentFrames()
        if !frames.isEmpty {
            let frame = frames[frameIndex % frames.count]
            frame.draw(in: petRect, from: .zero, operation: .sourceOver, fraction: 1)
        } else {
            let fallbackRect = NSRect(x: bounds.midX - 24, y: bounds.midY - 24, width: 48, height: 48)
            NSColor(calibratedWhite: 0.1, alpha: 0.92).setFill()
            NSBezierPath(ovalIn: fallbackRect).fill()
            let attrs: [NSAttributedString.Key: Any] = [
                .font: NSFont.monospacedSystemFont(ofSize: 19, weight: .bold),
                .foregroundColor: NSColor.white,
            ]
            let text = NSString(string: "C")
            let size = text.size(withAttributes: attrs)
            text.draw(
                at: NSPoint(x: fallbackRect.midX - size.width / 2, y: fallbackRect.midY - size.height / 2),
                withAttributes: attrs
            )
        }

        guard badgeCount > 0 else { return }
        let label = String(min(badgeCount, 99)) as NSString
        let attrs: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: .bold),
            .foregroundColor: NSColor.white,
        ]
        let labelSize = label.size(withAttributes: attrs)
        let badgeWidth = max(22, labelSize.width + 12)
        let badgeRect = NSRect(
            x: bounds.maxX - badgeWidth - 2,
            y: bounds.maxY - 26,
            width: badgeWidth,
            height: 22
        )
        NSColor(calibratedRed: 0.66, green: 0.43, blue: 0.0, alpha: 1).setFill()
        NSBezierPath(roundedRect: badgeRect, xRadius: 11, yRadius: 11).fill()
        label.draw(
            at: NSPoint(
                x: badgeRect.midX - labelSize.width / 2,
                y: badgeRect.midY - labelSize.height / 2
            ),
            withAttributes: attrs
        )
    }

    override func mouseEntered(with event: NSEvent) {
        isHovering = true
        updateAnimationState(resetFrame: true)
    }

    override func mouseExited(with event: NSEvent) {
        isHovering = false
        updateAnimationState(resetFrame: true)
    }

    override func mouseDown(with event: NSEvent) {
        dragStartMouse = NSEvent.mouseLocation
        dragStartOrigin = panel?.frame.origin ?? .zero
        didDrag = false
    }

    override func mouseDragged(with event: NSEvent) {
        guard let panel else { return }
        let now = NSEvent.mouseLocation
        let dx = now.x - dragStartMouse.x
        let dy = now.y - dragStartMouse.y
        if abs(dx) > 2 || abs(dy) > 2 {
            didDrag = true
        }
        panel.setFrameOrigin(NSPoint(x: dragStartOrigin.x + dx, y: dragStartOrigin.y + dy))
    }

    override func mouseUp(with event: NSEvent) {
        if !didDrag {
            onExpand?()
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        let menu = NSMenu()
        let expandItem = NSMenuItem(title: "Expand", action: #selector(expandFromMenu(_:)), keyEquivalent: "")
        expandItem.target = self
        menu.addItem(expandItem)
        NSMenu.popUpContextMenu(menu, with: event, for: self)
    }

    @objc private func expandFromMenu(_ sender: Any?) {
        onExpand?()
    }

    deinit {
        stopAnimation()
    }
}

// Floating find-in-page overlay. Hosted as a subview of the WKWebView so it
// sits above page content. Uses NSVisualEffectView for the blurred pill look.
// WKWebView.find() requires macOS 12+; the bar shows on all versions but the
// search simply no-ops on macOS 11 (realistically unreachable by 2026).
final class FindBar: NSView, NSTextFieldDelegate, NSSearchFieldDelegate {

    // Callbacks wired up by AppDelegate.
    var onQueryChange: ((String) -> Void)?
    var onNext:        (() -> Void)?
    var onPrev:        (() -> Void)?
    var onClose:       (() -> Void)?

    // Exposed so AppDelegate can make it first responder.
    let searchField = NSSearchField()

    private let matchLabel  = NSTextField(labelWithString: "")
    private let prevButton  = NSButton()
    private let nextButton  = NSButton()
    private let closeButton = NSButton()

    private static let barW:  CGFloat = 460
    static  let barH:         CGFloat = 44
    private static let margin: CGFloat = 12

    static func frame(inView parent: NSView) -> NSRect {
        let x = ((parent.bounds.width - barW) / 2).rounded()
        // Handle both flipped (y=0 at top) and standard (y=0 at bottom) parents.
        let y = parent.isFlipped
            ? margin
            : (parent.bounds.height - barH - margin).rounded()
        return NSRect(x: x, y: y, width: barW, height: barH)
    }

    override init(frame: NSRect) {
        super.init(frame: frame)
        buildUI()
    }
    required init?(coder: NSCoder) { fatalError() }

    private func buildUI() {
        wantsLayer = true
        // Drop shadow on the pill itself.
        layer?.shadowOpacity = 0.18
        layer?.shadowRadius  = 12
        layer?.shadowOffset  = CGSize(width: 0, height: -4)
        layer?.shadowColor   = NSColor.black.cgColor

        // Blurred material background — the pill.
        let vfx = NSVisualEffectView(frame: bounds)
        vfx.autoresizingMask = [.width, .height]
        vfx.material     = .hudWindow
        vfx.blendingMode = .behindWindow
        vfx.state        = .active
        vfx.wantsLayer   = true
        vfx.layer?.cornerRadius = 11
        vfx.layer?.masksToBounds = true
        addSubview(vfx)

        // Borderless search field — inherits blur background visually.
        searchField.placeholderString  = "Find in page"
        searchField.isBordered         = false
        searchField.drawsBackground    = false
        searchField.focusRingType      = .none
        searchField.font               = .systemFont(ofSize: 14)
        searchField.delegate           = self
        (searchField.cell as? NSSearchFieldCell)?.sendsSearchStringImmediately = true
        addSubview(searchField)

        // Match count / status label.
        matchLabel.font        = .systemFont(ofSize: 12)
        matchLabel.textColor   = .secondaryLabelColor
        matchLabel.alignment   = .right
        matchLabel.isSelectable = false
        addSubview(matchLabel)

        // Nav buttons — SF Symbols chevrons.
        for (btn, sym, sel) in [
            (prevButton,  "chevron.up",   #selector(prevTapped)),
            (nextButton,  "chevron.down", #selector(nextTapped)),
        ] as [(NSButton, String, Selector)] {
            btn.image = NSImage(systemSymbolName: sym, accessibilityDescription: nil)
            btn.bezelStyle    = .texturedRounded
            btn.isBordered    = false
            btn.imagePosition = .imageOnly
            btn.target = self
            btn.action = sel
            addSubview(btn)
        }

        // Close — filled circle xmark, muted.
        closeButton.image = NSImage(systemSymbolName: "xmark.circle.fill",
                                    accessibilityDescription: "Close")
        closeButton.bezelStyle    = .texturedRounded
        closeButton.isBordered    = false
        closeButton.imagePosition = .imageOnly
        if #available(macOS 11.0, *) {
            closeButton.contentTintColor = .quaternaryLabelColor
        }
        closeButton.target = self
        closeButton.action = #selector(closeTapped)
        addSubview(closeButton)
    }

    override func layout() {
        super.layout()
        let h   = bounds.height
        let pad: CGFloat  = 14
        let gap: CGFloat  = 6
        let btnW: CGFloat = 22
        let closeW: CGFloat = 18
        let labelW: CGFloat = 76

        // Layout right-to-left.
        var rx = bounds.width - pad

        rx -= closeW
        closeButton.frame = NSRect(x: rx, y: (h - closeW) / 2, width: closeW, height: closeW)

        rx -= gap + btnW
        nextButton.frame = NSRect(x: rx, y: (h - btnW) / 2, width: btnW, height: btnW)

        rx -= 2 + btnW
        prevButton.frame = NSRect(x: rx, y: (h - btnW) / 2, width: btnW, height: btnW)

        rx -= gap + labelW
        matchLabel.frame = NSRect(x: rx, y: (h - 16) / 2, width: labelW, height: 16)

        let fieldH: CGFloat = 28
        searchField.frame = NSRect(
            x: pad, y: (h - fieldH) / 2,
            width: rx - pad - gap, height: fieldH
        )
    }

    func setStatus(_ text: String, isError: Bool = false) {
        matchLabel.stringValue = text
        matchLabel.textColor   = isError ? .systemRed : .secondaryLabelColor
    }

    // MARK: Actions
    @objc private func prevTapped()  { onPrev?()  }
    @objc private func nextTapped()  { onNext?()  }
    @objc private func closeTapped() { onClose?() }

    // MARK: NSTextFieldDelegate — live search + keyboard nav inside the field
    func controlTextDidChange(_ obj: Notification) {
        onQueryChange?(searchField.stringValue)
    }

    func control(_ control: NSControl, textView: NSTextView,
                 doCommandBy commandSelector: Selector) -> Bool {
        switch commandSelector {
        case #selector(NSResponder.insertNewline(_:)):
            onNext?()
            return true
        case #selector(NSResponder.insertBacktab(_:)):   // Shift+Tab → prev
            onPrev?()
            return true
        case #selector(NSResponder.cancelOperation(_:)): // Esc
            onClose?()
            return true
        default:
            return false
        }
    }
}

let arguments = CommandLine.arguments
guard arguments.count >= 2, let url = URL(string: arguments[1]) else {
    FileHandle.standardError.write(
        Data("usage: wrapper <url> [app-name] [port] [pid-file] [polyfill-js-path] [companion-path] [launch-mode]\n".utf8))
    exit(2)
}
let appName = arguments.count >= 3 ? arguments[2] : "App"
let port = arguments.count >= 4 ? Int(arguments[3]) : nil
let pidFilePath = arguments.count >= 5 && !arguments[4].isEmpty ? arguments[4] : nil
let polyfillJSPath = arguments.count >= 6 && !arguments[5].isEmpty ? arguments[5] : nil
let companionPath = arguments.count >= 7 && !arguments[6].isEmpty ? arguments[6] : nil
let launchMode = arguments.count >= 8 && !arguments[7].isEmpty ? arguments[7] : nil

let app = NSApplication.shared
let delegate = AppDelegate(
    url: url,
    appName: appName,
    port: port,
    pidFilePath: pidFilePath,
    polyfillJSPath: polyfillJSPath,
    companionPath: companionPath,
    launchMode: launchMode
)
app.delegate = delegate
app.setActivationPolicy(launchMode == "menu-bar" ? .accessory : .regular)
app.run()
