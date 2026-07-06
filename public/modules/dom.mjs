// Shared DOM helpers: element construction, text escaping, the toast, and the
// dialog focus trap. Pure browser utilities with one dependency — the toast
// reaches the cached #toast node via `elements` — so every UI module can build
// markup the same way without importing back into app.js.

import { elements } from './state.mjs';

// The <template> cloned into every copy button across the board and library.
export const copyIconTemplate = document.querySelector('#copy-icon-template');

export function inlineMarkdown(text) {
  const codeSpans = [];
  let html = escapeHtml(text).replace(/`([^`]+)`/g, (_, code) => {
    const token = `@@CODE_${codeSpans.length}@@`;
    codeSpans.push(`<code>${code}</code>`);
    return token;
  });

  html = html
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');

  for (let index = 0; index < codeSpans.length; index += 1) {
    html = html.replace(`@@CODE_${index}@@`, codeSpans[index]);
  }

  return html;
}

export function element(tagName, options = {}) {
  const node = document.createElement(tagName);

  if (options.className) {
    node.className = options.className;
  }

  if (options.id) {
    node.id = options.id;
  }

  if (options.type) {
    node.type = options.type;
  }

  if (options.text !== undefined) {
    node.textContent = options.text;
  }

  if (options.html !== undefined) {
    node.innerHTML = options.html;
  }

  if (options.href) {
    node.href = options.href;
  }

  if (options.download) {
    node.download = options.download;
  }

  if (options.title) {
    node.title = options.title;
  }

  if (options.ariaLabel) {
    node.setAttribute('aria-label', options.ariaLabel);
  }

  if (options.ariaPressed) {
    node.setAttribute('aria-pressed', options.ariaPressed);
  }

  if (options.ariaHidden) {
    node.setAttribute('aria-hidden', options.ariaHidden);
  }

  if (options.dataset) {
    for (const [key, value] of Object.entries(options.dataset)) {
      node.dataset[key] = String(value);
    }
  }

  return node;
}

export function splitParagraphs(text) {
  return text
    .split(/\n{2,}/)
    .map((paragraph) => paragraph.replace(/\n/g, ' ').trim())
    .filter(Boolean);
}

export function escapeHtml(value) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function cssEscape(value) {
  if (window.CSS?.escape) {
    return window.CSS.escape(value);
  }

  return value.replace(/"/g, '\\"');
}

export function fileNameFromPath(filePath) {
  return filePath.split(/[\\/]/).pop();
}

export function formatTime(isoString) {
  const date = new Date(isoString);
  const diffMs = Date.now() - date.getTime();
  if (diffMs < 60_000) return 'just now';
  if (diffMs < 3_600_000) return `${Math.round(diffMs / 60_000)}m ago`;
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function showToast(message, duration = 2600) {
  elements.toast.textContent = message;
  elements.toast.classList.add('visible');
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    elements.toast.classList.remove('visible');
  }, duration);
}

export function trapDialogFocus(event, container) {
  const focusable = Array.from(
    container.querySelectorAll(
      'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ),
  ).filter((node) => node instanceof HTMLElement && node.offsetParent !== null);

  if (focusable.length === 0) return;

  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
    return;
  }

  if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

// Set or clear the board's campaign logo + favicon. Lives here (not in the board
// renderer) because the library view calls it to reset the logo on entry.
export function applyCampaignLogo(id, hasLogo) {
  const logoEl = document.querySelector('#campaign-logo');
  const favicon = document.querySelector('link[rel="icon"]');

  if (hasLogo && id) {
    const src = `/api/registry/icon?id=${encodeURIComponent(id)}`;
    if (logoEl) {
      logoEl.hidden = false;
      logoEl.src = src;
      logoEl.addEventListener(
        'error',
        () => {
          logoEl.hidden = true;
          logoEl.removeAttribute('src');
        },
        { once: true },
      );
    }
    if (favicon) favicon.href = src;
    return;
  }

  if (logoEl) {
    logoEl.hidden = true;
    logoEl.removeAttribute('src');
  }
  if (favicon) favicon.href = '/favicon.svg';
}

// Copy a campaign's file path to the clipboard with a toast either way. Shared by
// the board's "copy path" control and the library card copy buttons.
export async function copyCampaignPath(filePath) {
  if (!filePath) {
    showToast('No campaign path to copy yet.');
    return;
  }
  try {
    await navigator.clipboard.writeText(filePath);
    showToast('Path copied.');
  } catch {
    showToast('Copy failed. Select the path manually.');
  }
}

// Relative 'time ago' label for a timestamp — 'just now', 'Nm ago', 'Nh ago',
// 'Nd ago', then an absolute date. Shared by the library card timestamps and the
// board's save-status readout.
export function relativeTime(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (Number.isNaN(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  if (ms < 7 * 86_400_000) return `${Math.round(ms / 86_400_000)}d ago`;
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(iso));
}
