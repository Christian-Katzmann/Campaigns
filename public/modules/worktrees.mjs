import { formatWorktreeAge, formatWorktreeSize, sortWorktrees } from '../lib/worktrees.mjs';
import { element, showToast, trapDialogFocus } from './dom.mjs';

const panelState = {
  worktrees: [],
  sortBy: 'age',
  direction: 'desc',
};

export function initWorktreesPanel() {
  const trigger = document.querySelector('#worktrees-button');
  const panel = document.querySelector('#worktrees-panel');
  const dialog = panel?.querySelector('.worktrees-panel-dialog');
  const refresh = document.querySelector('#worktrees-refresh');
  const cleanup = document.querySelector('#worktrees-cleanup');
  if (!trigger || !panel || !dialog) return;

  let previouslyFocused = null;
  const open = () => {
    previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panel.removeAttribute('hidden');
    trigger.setAttribute('aria-expanded', 'true');
    loadWorktrees();
    dialog.querySelector('[data-action="close-worktrees"]')?.focus();
  };
  const close = () => {
    panel.setAttribute('hidden', '');
    trigger.setAttribute('aria-expanded', 'false');
    if (previouslyFocused && document.contains(previouslyFocused)) previouslyFocused.focus();
    else trigger.focus();
  };

  trigger.addEventListener('click', open);
  panel.querySelectorAll('[data-action="close-worktrees"]').forEach((button) => {
    button.addEventListener('click', close);
  });
  panel.querySelectorAll('[data-worktree-sort]').forEach((button) => {
    button.addEventListener('click', () => {
      const sortBy = button.dataset.worktreeSort;
      if (panelState.sortBy === sortBy) {
        panelState.direction = panelState.direction === 'desc' ? 'asc' : 'desc';
      } else {
        panelState.sortBy = sortBy;
        panelState.direction = 'desc';
      }
      renderWorktrees();
    });
  });
  refresh?.addEventListener('click', loadWorktrees);
  cleanup?.addEventListener('click', cleanupOrphans);
  panel.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
    } else if (event.key === 'Tab') {
      trapDialogFocus(event, panel);
    }
  });
}

async function loadWorktrees() {
  const list = document.querySelector('#worktrees-list');
  if (!list) return;
  list.replaceChildren(element('p', { className: 'worktrees-empty', text: 'Scanning worktrees…' }));
  try {
    const response = await fetch('/api/worktrees');
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not scan worktrees.');
    panelState.worktrees = Array.isArray(payload.worktrees) ? payload.worktrees : [];
    renderWorktrees();
  } catch (error) {
    list.replaceChildren(element('p', { className: 'worktrees-empty worktrees-empty--error', text: error.message }));
  }
}

function renderWorktrees() {
  const list = document.querySelector('#worktrees-list');
  const cleanup = document.querySelector('#worktrees-cleanup');
  if (!list) return;

  const rows = sortWorktrees(panelState.worktrees, panelState.sortBy, panelState.direction);
  syncSortControls();
  if (cleanup) {
    const orphanCount = rows.filter((row) => row.status === 'orphan').length;
    cleanup.disabled = orphanCount === 0;
    cleanup.textContent = orphanCount > 0 ? `Clean up orphans (${orphanCount})` : 'No orphans';
  }

  if (rows.length === 0) {
    list.replaceChildren(element('p', {
      className: 'worktrees-empty',
      text: 'No Git worktrees found. This panel scans repositories containing registered campaign files.',
    }));
    return;
  }

  list.replaceChildren(...rows.map(renderWorktreeRow));
}

function renderWorktreeRow(row) {
  const article = element('article', { className: `worktree-row worktree-row--${row.status}` });
  const main = element('div', { className: 'worktree-row-main' });
  const title = element('div', { className: 'worktree-row-title' });
  title.append(
    element('strong', { text: row.branch || 'Detached HEAD' }),
    element('span', { className: `worktree-status worktree-status--${row.status}`, text: statusLabel(row.status) }),
  );
  main.append(
    title,
    element('span', { className: 'worktree-repo', text: row.repo_name }),
    element('code', { className: 'worktree-path', text: row.path }),
  );

  const facts = element('div', { className: 'worktree-row-facts' });
  facts.append(
    fact('Size', row.primary ? 'Primary' : formatWorktreeSize(row.size_bytes)),
    fact('Touched', formatWorktreeAge(row.last_touched_at)),
    fact('Owner', ownerLabel(row)),
  );

  const actions = element('div', { className: 'worktree-row-actions' });
  if (row.deletable) {
    const remove = element('button', {
      className: `button button-quiet worktree-remove${row.status === 'live' ? ' worktree-remove--live' : ''}`,
      type: 'button',
      text: row.status === 'live' ? 'Stop & remove' : 'Delete',
      ariaLabel: `Delete worktree ${row.branch || row.path}`,
    });
    remove.addEventListener('click', () => deleteRow(row, remove));
    actions.append(remove);
  }

  article.append(main, facts, actions);
  return article;
}

function fact(label, value) {
  const item = element('span', { className: 'worktree-fact' });
  item.append(
    element('span', { className: 'worktree-fact-label', text: label }),
    element('strong', { text: value }),
  );
  return item;
}

async function deleteRow(row, button) {
  const prompt = row.status === 'live'
    ? `Stop the live ${row.owner.campaign_name || 'campaign'} run and remove this worktree?`
    : `Delete worktree ${row.branch || row.path}?`;
  if (!window.confirm(prompt)) return;
  button.disabled = true;
  try {
    let response = await deleteRequest({ path: row.path });
    let payload = await response.json();
    if (response.status === 409 && payload.confirmationRequired) {
      response = await deleteRequest({ path: row.path, confirm: true });
      payload = await response.json();
    }
    if (!response.ok) throw new Error(payload.error || 'Could not remove the worktree.');
    showToast('Worktree removed.');
    await loadWorktrees();
  } catch (error) {
    showToast(error.message, 4500);
    button.disabled = false;
  }
}

async function cleanupOrphans() {
  const count = panelState.worktrees.filter((row) => row.status === 'orphan').length;
  if (count === 0 || !window.confirm(`Delete ${count} orphaned worktree${count === 1 ? '' : 's'}?`)) return;
  const button = document.querySelector('#worktrees-cleanup');
  if (button) button.disabled = true;
  try {
    const response = await deleteRequest({ cleanup: 'orphans' });
    const payload = await response.json();
    if (!response.ok) throw new Error(payload.error || 'Could not clean up worktrees.');
    showToast(`Removed ${payload.removed.length} orphaned worktree${payload.removed.length === 1 ? '' : 's'}.`);
    await loadWorktrees();
  } catch (error) {
    showToast(error.message, 4500);
    if (button) button.disabled = false;
  }
}

function syncSortControls() {
  document.querySelectorAll('[data-worktree-sort]').forEach((button) => {
    const active = button.dataset.worktreeSort === panelState.sortBy;
    button.setAttribute('aria-pressed', String(active));
    button.dataset.direction = active ? panelState.direction : '';
    const label = button.dataset.worktreeSort === 'size' ? 'size' : 'age';
    button.setAttribute(
      'aria-label',
      active ? `Sort by ${label}, ${panelState.direction === 'desc' ? 'descending' : 'ascending'}` : `Sort by ${label}`,
    );
  });
}

function deleteRequest(body) {
  return fetch('/api/worktrees', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function ownerLabel(row) {
  if (row.owner.backend === 'external') return 'External';
  const name = row.owner.campaign_name ? ` · ${row.owner.campaign_name}` : '';
  return `${row.owner.backend[0].toUpperCase()}${row.owner.backend.slice(1)}${name}`;
}

function statusLabel(status) {
  return {
    primary: 'Primary',
    live: 'Live',
    locked: 'Locked',
    held: 'Held',
    orphan: 'Orphan',
    external: 'External',
  }[status] ?? status;
}
