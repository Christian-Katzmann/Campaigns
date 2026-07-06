// The Switch menu: the campaign dropdown in the topbar. Builds the menu from the
// registry and handles its open/close + keyboard traversal. Reads shared state and
// borrows the library's campaign sort/label helpers; a leaf otherwise.

import { element } from './dom.mjs';
import { elements, state } from './state.mjs';
import { isComplete, relativeHomePath, sortCampaigns } from './library.mjs';

export async function initSwitcher() {
  if (!elements.switchButton || !elements.switchMenu) return;

  let registry;
  try {
    const response = await fetch('/api/registry');
    if (!response.ok) return;
    registry = await response.json();
  } catch {
    return;
  }

  state.homeDir = typeof registry.homeDir === 'string' ? registry.homeDir : '';
  const campaigns = Array.isArray(registry.campaigns) ? registry.campaigns : [];

  // Always show the home + switcher on a campaign view.
  if (elements.homeButton) elements.homeButton.hidden = false;
  elements.switchButton.hidden = false;
  buildSwitchMenu(campaigns);

  elements.switchButton.addEventListener('click', (event) => {
    // event.detail === 0 for keyboard-activated clicks (Enter/Space on a focused button).
    toggleSwitchMenu({ focusFirst: event.detail === 0 });
  });
  elements.switchButton.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown' || event.key === 'Down') {
      event.preventDefault();
      openSwitchMenu(0);
    } else if (event.key === 'ArrowUp' || event.key === 'Up') {
      event.preventDefault();
      openSwitchMenu(-1);
    }
  });
  elements.switchMenu.addEventListener('keydown', handleSwitchMenuKeydown);
  document.addEventListener('click', (event) => {
    if (
      !elements.switchMenu.contains(event.target) &&
      !elements.switchButton.contains(event.target)
    ) {
      closeSwitchMenu();
    }
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeSwitchMenu();
  });
}

export function buildSwitchMenu(campaigns) {
  const sorted = sortCampaigns(campaigns);
  const children = [];

  const allLink = element('a', {
    className: 'switch-all',
    href: '?library',
    text: 'All campaigns',
  });
  allLink.setAttribute('role', 'menuitem');
  allLink.tabIndex = -1;
  children.push(allLink);
  children.push(element('div', { className: 'switch-divider', ariaHidden: 'true' }));

  for (const campaign of sorted) {
    const isCurrent = campaign.id === state.id;
    const item = isCurrent
      ? element('div', {
          className: `switch-current switch-item${isComplete(campaign) ? ' complete' : ''}`,
        })
      : element('a', {
          className: `switch-item${isComplete(campaign) ? ' complete' : ''}${campaign.missing ? ' missing' : ''}`,
          href: `?id=${encodeURIComponent(campaign.id)}`,
        });
    if (isCurrent) {
      // Keep the current campaign in the accessibility tree, but mark it
      // disabled so keyboard traversal skips it and screen readers announce
      // it as the active item.
      item.setAttribute('role', 'menuitem');
      item.setAttribute('aria-disabled', 'true');
      item.setAttribute('aria-current', 'true');
    } else {
      item.setAttribute('role', 'menuitem');
      item.tabIndex = -1;
    }

    const text = element('span', { className: 'switch-item-text' });
    text.append(
      element('span', { className: 'switch-title', text: campaign.title || 'Untitled' }),
      element('span', {
        className: 'switch-meta',
        text: switchMetaLine(campaign),
      }),
    );

    if (campaign.hasLogo) {
      item.classList.add('switch-item-with-logo');
      const logo = element('img', { className: 'switch-item-logo', alt: '' });
      logo.src = `/api/registry/icon?id=${encodeURIComponent(campaign.id)}`;
      logo.loading = 'lazy';
      logo.decoding = 'async';
      logo.addEventListener('error', () => {
        logo.remove();
        item.classList.remove('switch-item-with-logo');
      }, { once: true });
      item.append(logo, text);
    } else {
      item.append(text);
    }

    children.push(item);
  }

  elements.switchMenu.replaceChildren(...children);
}

export function switchMetaLine(campaign) {
  if (campaign.missing) return 'File missing';
  if (campaign.progress?.total > 0) {
    return isComplete(campaign)
      ? 'All done'
      : `${campaign.progress.done} / ${campaign.progress.total}`;
  }
  return relativeHomePath(campaign.filePath, state.homeDir);
}

export function toggleSwitchMenu(options = {}) {
  if (!elements.switchMenu) return;
  if (elements.switchMenu.hidden) {
    openSwitchMenu(options.focusFirst ? 0 : null);
  } else {
    closeSwitchMenu();
  }
}

export function openSwitchMenu(focusIndex) {
  if (!elements.switchMenu) return;
  if (elements.switchMenu.hidden) {
    elements.switchMenu.hidden = false;
    elements.switchButton.setAttribute('aria-expanded', 'true');
  }
  if (typeof focusIndex === 'number') focusSwitchMenuItem(focusIndex);
}

export function closeSwitchMenu() {
  if (!elements.switchMenu || elements.switchMenu.hidden) return;
  const hadFocusInside = elements.switchMenu.contains(document.activeElement);
  elements.switchMenu.hidden = true;
  elements.switchButton.setAttribute('aria-expanded', 'false');
  // Return focus to the trigger only if it was inside the menu — don't steal
  // focus from whatever the user clicked outside the menu.
  if (hadFocusInside) elements.switchButton.focus();
}

export function getSwitchMenuItems() {
  if (!elements.switchMenu) return [];
  return Array.from(
    elements.switchMenu.querySelectorAll('[role="menuitem"]:not([aria-disabled="true"])'),
  );
}

export function focusSwitchMenuItem(index) {
  const items = getSwitchMenuItems();
  if (items.length === 0) return;
  const wrapped = ((index % items.length) + items.length) % items.length;
  items[wrapped].focus();
}

export function handleSwitchMenuKeydown(event) {
  const items = getSwitchMenuItems();
  if (items.length === 0) return;
  const currentIndex = items.indexOf(document.activeElement);

  switch (event.key) {
    case 'ArrowDown':
    case 'Down':
      event.preventDefault();
      focusSwitchMenuItem(currentIndex < 0 ? 0 : currentIndex + 1);
      break;
    case 'ArrowUp':
    case 'Up':
      event.preventDefault();
      focusSwitchMenuItem(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
      break;
    case 'Tab':
      // Trap Tab inside the open menu so it cycles through items rather than
      // jumping back out to the page tab order. macOS native menus do the same.
      event.preventDefault();
      if (event.shiftKey) {
        focusSwitchMenuItem(currentIndex < 0 ? items.length - 1 : currentIndex - 1);
      } else {
        focusSwitchMenuItem(currentIndex < 0 ? 0 : currentIndex + 1);
      }
      break;
    case 'Home':
      event.preventDefault();
      focusSwitchMenuItem(0);
      break;
    case 'End':
      event.preventDefault();
      focusSwitchMenuItem(items.length - 1);
      break;
    // Enter activates a focused <a> natively — no handler needed.
  }
}
