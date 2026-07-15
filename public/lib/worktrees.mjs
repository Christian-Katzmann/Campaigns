export function sortWorktrees(worktrees, sortBy = 'age', direction = 'desc') {
  const multiplier = direction === 'asc' ? 1 : -1;
  const value = sortBy === 'size'
    ? (row) => Number(row.size_bytes) || 0
    : (row) => Date.parse(row.last_touched_at || '') || 0;
  return [...worktrees].sort((left, right) => {
    const difference = (value(left) - value(right)) * multiplier;
    return difference || left.path.localeCompare(right.path);
  });
}

export function formatWorktreeSize(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${formatNumber(bytes / (1024 * 1024))} MB`;
  return `${formatNumber(bytes / (1024 * 1024 * 1024))} GB`;
}

export function formatWorktreeAge(isoString, now = Date.now()) {
  const touched = Date.parse(isoString || '');
  if (!Number.isFinite(touched)) return 'Unknown';
  const elapsed = Math.max(0, now - touched);
  if (elapsed < 60_000) return 'Now';
  if (elapsed < 3_600_000) return `${Math.floor(elapsed / 60_000)}m`;
  if (elapsed < 86_400_000) return `${Math.floor(elapsed / 3_600_000)}h`;
  return `${Math.floor(elapsed / 86_400_000)}d`;
}

function formatNumber(value) {
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1);
}
