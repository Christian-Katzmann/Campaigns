// The library view: the campaign grid, collections (build, park, delete, drag,
// stack), the quick-filter, per-campaign lessons, and the automation status a
// card shows — its display helpers, its grid/collection dot updaters, and the
// unit-label formatter the drawer also reuses.
//
// Imports away for the "step out" entry points and reads the shared automation
// snapshot, but never calls the polling loop or the drawer, so the drawer can
// import this module's updaters without a cycle.

import {
  AUTOMATE_ATTENTION_STATUSES,
  AUTOMATE_SCHEDULED_STATUSES,
  automateDisplayStatus,
  automateState,
  elements,
  state,
} from './state.mjs';
import { applyCampaignLogo, copyCampaignPath, copyIconTemplate, element, relativeTime, showToast } from './dom.mjs';
import {
  awayActiveIdsIn,
  awayEntryButton,
  awayHumanizeId,
  openAwayMode,
  updateAwayAllButton,
} from './away.mjs';

export async function renderLibrary() {
  document.body.classList.add('view-library');
  applyCampaignLogo(null, false);
  if (!elements.library) return;
  elements.library.hidden = false;

  let registry;
  try {
    const automateRequest = state.capabilities.automate
      ? fetch('/api/automate-state').catch(() => null)
      : Promise.resolve(null);
    const [registryResponse, automateResponse] = await Promise.all([
      fetch('/api/registry'),
      automateRequest,
    ]);
    if (!registryResponse.ok) throw new Error('Could not load campaign registry.');
    registry = await registryResponse.json();
    if (automateResponse?.ok) {
      try {
        automateState.bulk = await automateResponse.json();
      } catch {
        automateState.bulk = {};
      }
    } else {
      automateState.bulk = {};
    }
  } catch (error) {
    if (elements.libraryEmpty) {
      const errorPara = document.createElement('p');
      errorPara.className = 'library-empty-body';
      errorPara.textContent = error.message;
      elements.libraryEmpty.replaceChildren(errorPara);
      elements.libraryEmpty.hidden = false;
    }
    return;
  }

  state.homeDir = typeof registry.homeDir === 'string' ? registry.homeDir : '';
  state.libraryCollections =
    registry.collections && typeof registry.collections === 'object' ? registry.collections : {};
  const campaigns = Array.isArray(registry.campaigns) ? registry.campaigns : [];
  if (state.capabilities.lessons) {
    renderLibraryLessons(await fetchCampaignLessons());
  } else if (elements.libraryLessons) {
    elements.libraryLessons.hidden = true;
    elements.libraryLessons.replaceChildren();
  }

  if (campaigns.length === 0) {
    elements.libraryEmpty.hidden = false;
    elements.libraryGrid.hidden = true;
    return;
  }
  elements.libraryEmpty.hidden = true;
  elements.libraryGrid.hidden = false;

  state.libraryCampaigns = sortCampaigns(campaigns);
  if (elements.libraryFilter) {
    // The filter only earns header space once the library is big enough
    // for scanning to be slower than typing.
    elements.libraryFilter.hidden = state.libraryCampaigns.length < 8;
  }
  applyLibraryFilter();
}

export function applyLibraryFilter() {
  const all = state.libraryCampaigns;
  const query = state.libraryFilter.trim().toLowerCase();
  const filtering = query.length > 0;
  const matches = filtering
    ? all.filter((campaign) =>
        `${campaign.title ?? ''} ${pathProjectName(campaign.filePath ?? '')}`
          .toLowerCase()
          .includes(query),
      )
    : all;

  if (elements.libraryFilterCount) {
    elements.libraryFilterCount.hidden = !filtering;
    elements.libraryFilterCount.textContent = `${matches.length} of ${all.length}`;
  }

  if (filtering && matches.length === 0) {
    elements.libraryGrid.replaceChildren(
      element('p', {
        className: 'library-filter-empty',
        text: `No campaigns match “${state.libraryFilter.trim()}”.`,
      }),
    );
    return;
  }

  elements.libraryGrid.replaceChildren(
    ...buildLibraryItems(matches, { forceExpanded: filtering }),
  );
}

export function initLibraryFilter() {
  const input = elements.libraryFilter;
  if (!input) return;

  input.addEventListener('input', () => {
    state.libraryFilter = input.value;
    applyLibraryFilter();
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      if (input.value) {
        input.value = '';
        state.libraryFilter = '';
        applyLibraryFilter();
      } else {
        input.blur();
      }
      return;
    }
    if (event.key === 'Enter') {
      // Enter opens the first (usually only) match.
      elements.libraryGrid.querySelector('.library-card-link')?.click();
    }
  });
}

export async function fetchCampaignLessons() {
  try {
    const response = await fetch('/api/lessons');
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not load lessons.');
    return payload;
  } catch (error) {
    return {
      available: false,
      error: error.message || 'Could not load lessons.',
    };
  }
}

export function renderLibraryLessons(lessons) {
  if (!elements.libraryLessons) return;

  if (!lessons?.available) {
    const header = element('div', { className: 'library-lessons-header' });
    header.append(
      element('span', { className: 'library-lessons-title', text: 'Lessons' }),
      element('span', { className: 'library-lessons-meta', text: 'Unavailable' }),
    );
    elements.libraryLessons.hidden = false;
    elements.libraryLessons.replaceChildren(
      header,
      element('p', {
        className: 'library-lessons-unavailable',
        text: lessons?.error || 'Campaign lessons are unavailable.',
      }),
    );
    return;
  }

  const backends = new Map((lessons.backends || []).map((backend) => [backend.id, backend]));
  const claude = backends.get('claude');
  const codex = backends.get('codex');
  const total = positiveWholeNumber(lessons.scanned?.total);
  const metricItems = [
    lessonMetric('First try', backendRates([claude, codex], 'firstTryRate')),
    lessonMetric('Rework', backendRates([claude, codex], 'reworkRate')),
    lessonMetric('Halts', haltSummary(lessons.halt)),
    lessonMetric('Recovery', recoverySummary(lessons.recovery)),
    lessonMetric('Warnings', dataQualitySummary(lessons.dataQuality)),
    lessonMetric('Step count', sizingSummary(lessons.sizing)),
  ];

  const header = element('div', { className: 'library-lessons-header' });
  header.append(
    element('span', { className: 'library-lessons-title', text: 'Lessons' }),
    element('span', {
      className: 'library-lessons-meta',
      text: total > 0 ? `${total} local runs scanned` : 'Local run history',
    }),
  );

  const metrics = element('div', { className: 'library-lessons-metrics' });
  metrics.replaceChildren(...metricItems);

  const tags = renderLessonTags(lessons.reasons);
  elements.libraryLessons.hidden = false;
  elements.libraryLessons.replaceChildren(header, metrics, tags);
}

export function lessonMetric(label, value) {
  const item = element('div', { className: 'library-lessons-metric' });
  item.append(
    element('span', { className: 'library-lessons-metric-label', text: label }),
    element('span', { className: 'library-lessons-metric-value', text: value }),
  );
  return item;
}

export function backendRates(backends, field) {
  const parts = backends
    .filter(Boolean)
    .map((backend) => `${backend.label} ${formatPercent(backend[field])}`);
  return parts.length ? parts.join(' / ') : 'No verdicts yet';
}

export function haltSummary(halt) {
  const overall = formatPercent(halt?.overallRate);
  const highStep = formatPercent(halt?.highStepCountRate);
  if (overall === 'n/a' && highStep === 'n/a') return 'No halt signal yet';
  return `${overall} overall / ${highStep} above guidance`;
}

export function recoverySummary(recovery) {
  const campaigns = positiveWholeNumber(recovery?.campaigns);
  const events = positiveWholeNumber(recovery?.events);
  if (campaigns === 0 && events === 0) return 'No recoveries logged';
  return `${campaigns} campaign${campaigns === 1 ? '' : 's'} / ${events} event${events === 1 ? '' : 's'}`;
}

export function dataQualitySummary(dataQuality) {
  const warnings = positiveWholeNumber(dataQuality?.warnings);
  if (warnings === 0) return 'No warnings';
  return `${warnings} warning${warnings === 1 ? '' : 's'}`;
}

export function sizingSummary(sizing) {
  const avoidAbove = positiveWholeNumber(sizing?.avoidAboveSteps);
  const median = formatCompactNumber(sizing?.medianSteps);
  if (avoidAbove > 0) return `Avoid above ${avoidAbove}; median ${median}`;
  return median === 'n/a' ? 'No sizing data' : `Median ${median}`;
}

export function renderLessonTags(reasons) {
  const row = element('div', { className: 'library-lessons-tags' });
  const tags = Array.isArray(reasons?.topTags) ? reasons.topTags : [];

  row.append(element('span', { className: 'library-lessons-tags-label', text: 'Reason tags' }));

  if (tags.length > 0) {
    for (const tag of tags) {
      row.append(renderLessonTag(tag));
    }
    return row;
  }

  const legacy = Array.isArray(reasons?.legacyTopTags) ? reasons.legacyTopTags : [];
  if (legacy.length > 0) {
    row.append(element('span', { className: 'library-lessons-tags-empty', text: 'Legacy' }));
    for (const tag of legacy) {
      row.append(renderLessonTag(tag, { legacy: true }));
    }
    return row;
  }

  row.append(element('span', { className: 'library-lessons-tags-empty', text: 'No review tags yet.' }));
  return row;
}

export function renderLessonTag(tag, options = {}) {
  return element('span', {
    className: `library-lessons-tag${options.legacy ? ' legacy' : ''}`,
    text: `${tag.tag} ${positiveWholeNumber(tag.count)}`,
  });
}

export function formatPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return `${Math.round(number * 100)}%`;
}

export function formatCompactNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 'n/a';
  return Number.isInteger(number) ? String(number) : number.toFixed(1);
}

export function sortCampaigns(campaigns) {
  return [...campaigns].sort((a, b) => {
    const bucketDiff = campaignBucket(a) - campaignBucket(b);
    if (bucketDiff !== 0) return bucketDiff;
    return campaignActivityMs(b) - campaignActivityMs(a);
  });
}

export function campaignBucket(campaign) {
  if (isComplete(campaign)) return 2;
  if (campaign.parkedAt) return 1;
  return 0;
}

export function campaignActivityMs(campaign) {
  const iso = campaign.lastActivityAt || campaign.lastOpenedAt || campaign.createdAt;
  if (!iso) return 0;
  const ms = new Date(iso).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

export function isComplete(campaign) {
  return normalizeProgress(campaign.progress).complete;
}

export function campaignDisplayState(campaign, data = automateState.bulk?.[campaign.id]) {
  const automation = libraryAutomationCardStatus(data);
  if (automation) {
    const kind = automation.status === 'active' || AUTOMATE_SCHEDULED_STATUSES.has(automation.status)
      ? 'running'
      : 'needs-attention';
    return { kind, automation };
  }
  if (campaign.missing) return { kind: 'missing', automation: null };
  if (isComplete(campaign)) return { kind: 'finished', automation: null };
  if (campaign.parkedAt) return { kind: 'sleeping', automation: null };
  return { kind: 'idle', automation: null };
}

export function normalizeProgress(progress) {
  const total = positiveWholeNumber(progress?.total);
  const done = Math.min(positiveWholeNumber(progress?.done), total);
  return {
    complete: total > 0 && done === total,
    done,
    ratio: total > 0 ? done / total : 0,
    total,
  };
}

export function positiveWholeNumber(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 0;
  return Math.floor(number);
}

export function buildLibraryItems(campaigns, { forceExpanded = false } = {}) {
  const entries = groupLibraryCampaigns(campaigns);
  const active = [];
  const parked = [];
  const complete = [];

  for (const entry of entries) {
    if (entry.bucket === 2) {
      complete.push(entry);
    } else if (entry.bucket === 1) {
      parked.push(entry);
    } else {
      active.push(entry);
    }
  }

  const children = active.flatMap((entry) => buildLibraryEntry(entry));

  if (parked.length > 0) {
    const parkedCampaignCount = parked.reduce(
      (count, entry) => count + libraryEntryCampaignCount(entry),
      0,
    );
    children.push(buildParkedCampaignDivider(parkedCampaignCount));
    if (state.libraryParkedExpanded || forceExpanded) {
      children.push(...parked.flatMap((entry) => buildLibraryEntry(entry)));
    }
  }

  if (complete.length > 0) {
    const completeCampaignCount = complete.reduce(
      (count, entry) => count + libraryEntryCampaignCount(entry),
      0,
    );
    children.push(buildCompleteCampaignDivider(completeCampaignCount));
    if (state.libraryCompleteExpanded || forceExpanded) {
      children.push(...complete.flatMap((entry) => buildLibraryEntry(entry)));
    }
  }

  return children;
}

export function groupLibraryCampaigns(campaigns) {
  const groups = new Map();
  const entries = [];

  for (const campaign of campaigns) {
    const collectionId = campaignCollectionId(campaign);
    if (!collectionId) {
      entries.push({
        type: 'campaign',
        campaign,
        bucket: campaignBucket(campaign),
      });
      continue;
    }

    let group = groups.get(collectionId);
    if (!group) {
      group = {
        type: 'collection',
        id: collectionId,
        campaigns: [],
        bucket: 2,
      };
      groups.set(collectionId, group);
      entries.push(group);
    }

    group.campaigns.push(campaign);
    group.bucket = Math.min(group.bucket, campaignBucket(campaign));
  }

  return entries.flatMap((entry) => {
    if (entry.type !== 'collection' || entry.campaigns.length > 1) return [entry];
    return entry.campaigns.map((campaign) => ({
      type: 'campaign',
      campaign,
      bucket: campaignBucket(campaign),
    }));
  });
}

export function buildLibraryEntry(entry) {
  if (entry.type === 'campaign') return [buildLibraryCard(entry.campaign)];
  if (state.libraryExpandedCollections.has(entry.id)) {
    return [buildLibraryCollectionSection(entry)];
  }
  return [buildLibraryCollectionCard(entry)];
}

export function libraryEntryCampaignCount(entry) {
  return entry.type === 'collection' ? entry.campaigns.length : 1;
}

export function buildParkedCampaignDivider(count) {
  const expanded = state.libraryParkedExpanded;
  const label = `${count} sleeping campaign${count === 1 ? '' : 's'}`;
  const divider = element('div', {
    className: 'library-parked-divider',
    dataset: { expanded: String(expanded) },
  });

  const button = element('button', {
    className: 'library-parked-toggle',
    type: 'button',
    title: expanded ? 'Hide sleeping campaigns' : `Show ${label}`,
    ariaLabel: expanded ? 'Hide sleeping campaigns' : `Show ${label}`,
  });
  button.setAttribute('aria-expanded', String(expanded));
  button.append(
    element('span', { className: 'library-parked-symbol', text: expanded ? '-' : '+', ariaHidden: 'true' }),
    element('span', { className: 'library-divider-label', text: 'Sleeping campaigns' }),
    element('span', { className: 'library-divider-count', text: String(count) }),
  );
  button.addEventListener('click', () => {
    state.libraryParkedExpanded = !state.libraryParkedExpanded;
    renderLibrary();
  });

  divider.append(button);
  return divider;
}

export function buildCompleteCampaignDivider(count) {
  const expanded = state.libraryCompleteExpanded;
  const label = `${count} finished campaign${count === 1 ? '' : 's'}`;
  const divider = element('div', {
    className: 'library-parked-divider library-complete-divider',
    dataset: { expanded: String(expanded) },
  });

  const button = element('button', {
    className: 'library-parked-toggle library-complete-toggle',
    type: 'button',
    title: expanded ? 'Hide finished campaigns' : `Show ${label}`,
    ariaLabel: expanded ? 'Hide finished campaigns' : `Show ${label}`,
  });
  button.setAttribute('aria-expanded', String(expanded));
  button.append(
    element('span', { className: 'library-parked-symbol', text: expanded ? '-' : '+', ariaHidden: 'true' }),
    element('span', { className: 'library-divider-label', text: 'Finished campaigns' }),
    element('span', { className: 'library-divider-count', text: String(count) }),
  );
  button.addEventListener('click', () => {
    state.libraryCompleteExpanded = !state.libraryCompleteExpanded;
    renderLibrary();
  });

  divider.append(button);
  return divider;
}

export function buildLibraryCollectionCard(group) {
  const stats = collectionStats(group.campaigns);
  const complete = collectionComplete(stats);
  const parked = collectionParked(group, complete);
  const title = collectionDisplayName(group);
  const modifiers = [
    complete ? 'complete' : '',
    parked ? 'parked' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const card = element('article', {
    className: `library-card library-collection-card${modifiers ? ` ${modifiers}` : ''}`,
    dataset: {
      collectionId: group.id,
      campaignIds: group.campaigns.map((campaign) => campaign.id).join(' '),
    },
  });
  card.tabIndex = 0;
  card.setAttribute('role', 'button');
  card.setAttribute('aria-expanded', 'false');
  card.setAttribute('aria-label', `${title}. ${group.campaigns.length} campaigns. Press to expand.`);

  const toggle = () => toggleLibraryCollection(group.id);
  card.addEventListener('click', toggle);
  card.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    toggle();
  });
  bindLibraryDropTarget(card, { targetCollectionId: group.id });

  card.append(
    element('span', { className: 'library-card-title', text: title }),
    element('span', {
      className: 'library-card-path',
      text: `${group.campaigns.length} campaign${group.campaigns.length === 1 ? '' : 's'} collected`,
    }),
  );

  appendCollectionProgress(card, stats);
  card.append(
    element('span', {
      className: 'library-card-time',
      text: stats.lastActivityMs ? `Active ${relativeTime(new Date(stats.lastActivityMs).toISOString())}` : '',
    }),
    element('span', {
      className: 'library-collection-count',
      text: String(group.campaigns.length),
      ariaHidden: 'true',
    }),
  );
  if (!complete) {
    card.append(buildCollectionParkButton(group, parked));
  }
  card.append(buildCollectionCopyButton(group), buildCollectionRenameButton(group));

  return card;
}

export function buildLibraryCollectionSection(group) {
  const stats = collectionStats(group.campaigns);
  const complete = collectionComplete(stats);
  const parked = collectionParked(group, complete);
  const title = collectionDisplayName(group);
  const modifiers = [
    complete ? 'complete' : '',
    parked ? 'parked' : '',
  ]
    .filter(Boolean)
    .join(' ');
  const section = element('section', {
    className: `library-collection-section${modifiers ? ` ${modifiers}` : ''}`,
    dataset: {
      collectionId: group.id,
      campaignIds: group.campaigns.map((campaign) => campaign.id).join(' '),
    },
  });
  section.setAttribute('aria-label', title);
  bindLibraryDropTarget(section, { targetCollectionId: group.id });

  const header = element('button', {
    className: 'library-collection-header',
    type: 'button',
    title: 'Collapse collection',
    ariaLabel: 'Collapse collection',
  });
  header.setAttribute('aria-expanded', 'true');
  header.append(
    element('span', { className: 'library-collection-title', text: title }),
    element('span', {
      className: 'library-collection-meta',
      text: `${group.campaigns.length} campaign${group.campaigns.length === 1 ? '' : 's'} collected`,
    }),
    element('span', { className: 'library-collection-collapse', text: '-', ariaHidden: 'true' }),
  );
  header.addEventListener('click', () => toggleLibraryCollection(group.id));

  const grid = element('div', { className: 'library-collection-grid' });
  grid.replaceChildren(
    ...sortCollectionMembers(group.campaigns).map((campaign) =>
      buildLibraryCard(campaign, { collectionMember: true }),
    ),
  );

  if (stats.total > 0) {
    section.dataset.progress = `${stats.done}/${stats.total}`;
  }
  section.append(header);
  if (!complete) {
    section.append(buildCollectionParkButton(group, parked));
  }
  section.append(buildCollectionCopyButton(group), buildCollectionRenameButton(group), grid);
  return section;
}

export function appendCollectionProgress(parent, stats) {
  if (stats.total <= 0) return;

  const progress = element('div', { className: 'library-card-progress' });
  const track = element('div', { className: 'library-card-progress-track' });
  const fill = element('div', { className: 'library-card-progress-fill' });
  fill.style.width = `${Math.round((stats.done / stats.total) * 100)}%`;
  track.append(fill);
  progress.append(
    track,
    element('span', {
      className: 'library-card-progress-label',
      text: stats.done === stats.total ? 'All done' : `${stats.done} / ${stats.total}`,
    }),
  );
  parent.append(progress);
}

export function collectionStats(campaigns) {
  return campaigns.reduce(
    (stats, campaign) => {
      const progress = normalizeProgress(campaign.progress);
      stats.done += progress.done;
      stats.total += progress.total;
      stats.lastActivityMs = Math.max(stats.lastActivityMs, campaignActivityMs(campaign));
      return stats;
    },
    { done: 0, total: 0, lastActivityMs: 0 },
  );
}

export function collectionComplete(stats) {
  return stats.total > 0 && stats.done === stats.total;
}

export function collectionParked(group, complete) {
  return !complete && group.bucket === 1;
}

// Campaign families are numbered by implementation order ("1. …", "2a. …").
// When every member carries a numeric prefix, show and copy them in that
// order instead of activity order; otherwise leave the given order alone.
export function sortCollectionMembers(campaigns) {
  const keys = campaigns.map((campaign) => {
    const match = (campaign.title || '').match(/^(\d+)([a-z])?[.\s]/);
    return match ? [Number(match[1]), match[2] ?? ''] : null;
  });
  if (keys.some((key) => key === null)) return campaigns;
  return campaigns
    .map((campaign, index) => ({ campaign, key: keys[index] }))
    .sort((a, b) => a.key[0] - b.key[0] || a.key[1].localeCompare(b.key[1]))
    .map((entry) => entry.campaign);
}

// The stack's headline: the human/planner-set name when one is stored,
// otherwise the old derived title so unnamed stacks keep working.
export function collectionDisplayName(group) {
  const stored = state.libraryCollections?.[group.id]?.name;
  if (typeof stored === 'string' && stored.trim() !== '') return stored.trim();
  return collectionTitle(group.campaigns);
}

export function collectionTitle(campaigns) {
  const titles = campaigns.map((campaign) => campaign.title || '').filter(Boolean);
  const numbers = titles
    .map((title) => title.match(/^Campaign\s+(\d+)\b/i))
    .filter(Boolean)
    .map((match) => Number(match[1]))
    .filter((number) => Number.isFinite(number));

  if (numbers.length === titles.length && numbers.length > 1) {
    const sorted = [...new Set(numbers)].sort((a, b) => a - b);
    const isContiguous = sorted[sorted.length - 1] - sorted[0] + 1 === sorted.length;
    if (isContiguous) return `Campaigns ${sorted[0]}-${sorted[sorted.length - 1]}`;
    const visible = sorted.slice(0, 3).join(', ');
    return sorted.length > 3 ? `Campaigns ${visible} + ${sorted.length - 3}` : `Campaigns ${visible}`;
  }

  return titles[0] || 'Campaign collection';
}

export function campaignCollectionId(campaign) {
  return typeof campaign.collectionId === 'string' ? campaign.collectionId.trim() : '';
}

export function toggleLibraryCollection(collectionId) {
  if (state.libraryExpandedCollections.has(collectionId)) {
    state.libraryExpandedCollections.delete(collectionId);
  } else {
    state.libraryExpandedCollections.add(collectionId);
  }
  saveLibraryExpandedCollections();
  void renderLibrary().then(updateLibraryDots);
}

export function buildCollectionParkButton(group, parked) {
  const button = element('button', {
    className: 'library-collection-park-button',
    type: 'button',
    title: parked ? 'Reactivate stack' : 'Park stack',
    ariaLabel: parked ? 'Reactivate stack' : 'Park stack',
    ariaPressed: parked ? 'true' : 'false',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await toggleCollectionPark(group.id, !parked);
      await renderLibrary();
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not update stack park state.');
    }
  });
  return button;
}

export function buildCollectionCopyButton(group) {
  const button = element('button', {
    className: 'library-collection-copy-button',
    type: 'button',
    title: 'Copy automation link',
    ariaLabel: 'Copy automation link',
  });
  if (copyIconTemplate?.content?.firstElementChild) {
    button.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
  } else {
    button.textContent = 'Copy';
  }
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await copyCollectionAutomationLink(group);
  });
  return button;
}

export function buildCollectionRenameButton(group) {
  const button = element('button', {
    className: 'library-collection-rename-button',
    type: 'button',
    title: 'Rename stack',
    ariaLabel: 'Rename stack',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>';
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    const current = collectionDisplayName(group);
    const next = window.prompt('Stack name', current);
    if (next === null || next.trim() === current) return;
    try {
      await renameCollection(group.id, next.trim());
      await renderLibrary();
    } catch (error) {
      showToast(error.message || 'Could not rename stack.');
    }
  });
  return button;
}

export async function renameCollection(collectionId, name) {
  const response = await fetch('/api/registry/collection', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'rename', collectionId, name }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || 'Could not rename stack.');
  }
}

export async function copyCollectionAutomationLink(group) {
  const text = collectionAutomationText(group);
  try {
    await navigator.clipboard.writeText(text);
    showToast('Stack automation link copied.');
  } catch {
    showToast('Copy failed. Select the stack details manually.');
  }
}

export function collectionAutomationText(group) {
  const title = collectionDisplayName(group);
  const lines = [
    `Use $campaign-automate on campaigns-stack://${group.id}`,
    `Stack: ${title}`,
    'Campaign files:',
  ];

  for (const campaign of sortCollectionMembers(group.campaigns)) {
    if (campaign.filePath) lines.push(`- ${campaign.filePath}`);
  }

  return lines.join('\n');
}

export function buildLibraryCard(campaign, options = {}) {
  const complete = isComplete(campaign);
  const parked = Boolean(campaign.parkedAt) && !complete;
  const displayState = campaignDisplayState(campaign);
  const liveProgress = displayState.kind === 'running' ? displayState.automation?.progress : null;
  const progressStats = normalizeProgress(liveProgress ?? campaign.progress);
  const showLogo = campaign.hasLogo || shouldShowFallbackLogo(campaign, displayState);
  const modifiers = [
    complete ? 'complete' : '',
    parked ? 'parked' : '',
    campaign.missing ? 'missing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  const card = element('article', {
    className: `library-card${modifiers ? ` ${modifiers}` : ''}${showLogo ? ' has-logo' : ''}`,
    dataset: { campaignId: campaign.id, displayState: displayState.kind },
  });
  bindLibraryDragSource(card, campaign);
  bindLibraryDropTarget(card, { targetId: campaign.id });

  const link = element('a', {
    className: 'library-card-link',
    href: `?id=${encodeURIComponent(campaign.id)}`,
  });

  link.append(
    element('span', { className: 'library-card-title', text: campaign.title || 'Untitled' }),
    element('span', { className: 'library-card-path', text: relativeHomePath(campaign.filePath, state.homeDir) }),
  );

  if (progressStats.total > 0) {
    const progress = element('div', { className: 'library-card-progress' });
    const track = element('div', { className: 'library-card-progress-track' });
    const fill = element('div', { className: 'library-card-progress-fill' });
    fill.style.width = `${Math.round(progressStats.ratio * 100)}%`;
    track.append(fill);
    progress.append(
      track,
      element('span', {
        className: 'library-card-progress-label',
        text: complete
          ? 'All done'
          : `${progressStats.done} / ${progressStats.total}${liveProgress ? ' · live' : ''}`,
      }),
    );
    link.append(progress);
  }

  const status = buildLibraryCardStatus(displayState.automation, campaign.id, campaign.title);
  if (status) link.append(status);

  const executionLabel = formatExecutionContext(displayState.automation?.execution);
  const time = campaign.missing
    ? 'File missing'
    : displayState.kind === 'running'
      ? ['Working now', executionLabel].filter(Boolean).join(' · ')
      : `Active ${relativeTime(campaign.lastActivityAt || campaign.lastOpenedAt)}`;
  link.append(element('span', { className: 'library-card-time', text: time }));

  card.append(link);

  const chrome = element('div', { className: 'library-card-chrome' });

  if (campaign.hasLogo) {
    const logo = element('img', { className: 'library-card-logo', alt: '' });
    logo.src = `/api/registry/icon?id=${encodeURIComponent(campaign.id)}`;
    logo.loading = 'lazy';
    logo.decoding = 'async';
    logo.addEventListener('error', () => {
      if (shouldShowFallbackLogo(campaign, displayState)) {
        logo.replaceWith(buildFallbackLogo(campaign));
        return;
      }
      logo.remove();
      card.classList.remove('has-logo');
    }, { once: true });
    chrome.append(logo);
  } else if (showLogo) {
    chrome.append(buildFallbackLogo(campaign));
  }

  if (!complete && !campaign.missing) {
    chrome.append(buildParkButton(campaign, parked));
  } else if (campaign.missing) {
    chrome.append(buildDeleteMissingButton(campaign));
  }

  if (!campaign.missing) {
    chrome.append(buildDeleteButton(campaign));
  }

  if (chrome.childNodes.length > 0) {
    card.append(chrome);
  }

  if (campaign.filePath) {
    card.append(buildCampaignCopyButton(campaign));
  }

  if (options.collectionMember && campaignCollectionId(campaign) && !campaign.missing) {
    card.append(buildCollectionRemoveButton(campaign));
  }

  return card;
}

export function buildLibraryCardStatus(summary, id, title) {
  if (!summary) return null;
  const node = buildLibraryAutomationStatus(summary);
  if (summary.status === 'active') {
    node.append(
      awayEntryButton(
        '',
        () => openAwayMode({ mode: 'campaign', ids: [id], title: title || awayHumanizeId(id) }),
        'library-card-away-button',
      ),
    );
  }
  return node;
}

export function buildFallbackLogo(campaign) {
  return element('span', {
    className: 'library-card-logo library-card-logo-fallback',
    text: fallbackLogoText(campaign),
    ariaHidden: 'true',
  });
}

export function shouldShowFallbackLogo(campaign, displayState = campaignDisplayState(campaign)) {
  if (campaign.hasLogo || campaign.missing || isComplete(campaign) || campaign.parkedAt) return false;
  if (displayState.kind === 'running' || displayState.kind === 'needs-attention') return true;
  return normalizeProgress(campaign.progress).total > 0;
}

export function fallbackLogoText(campaign) {
  const title = String(campaign.title || pathProjectName(campaign.filePath) || 'Campaign');
  const normalized = title.normalize('NFKD').replace(/\p{M}/gu, '');
  const words = normalized
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  const letters = words.slice(0, 2).map((word) => word[0]).join('');
  return (letters || normalized.slice(0, 2) || 'C').toUpperCase();
}

export function pathProjectName(filePath) {
  const parts = String(filePath || '').split('/').filter(Boolean);
  const campaignsIndex = parts.lastIndexOf('campaigns');
  if (campaignsIndex > 0) return parts[campaignsIndex - 1];
  return parts.length > 1 ? parts[parts.length - 2] : '';
}

export function buildCampaignCopyButton(campaign) {
  const button = element('button', {
    className: 'library-card-copy-button',
    type: 'button',
    title: 'Copy campaign path',
    ariaLabel: 'Copy campaign path',
  });
  if (copyIconTemplate?.content?.firstElementChild) {
    button.append(copyIconTemplate.content.firstElementChild.cloneNode(true));
  } else {
    button.textContent = 'Copy';
  }
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await copyCampaignPath(campaign.filePath);
  });
  return button;
}

export function bindLibraryDragSource(card, campaign) {
  if (campaign.missing) return;

  card.draggable = true;
  card.addEventListener('dragstart', (event) => {
    if (event.target instanceof HTMLElement && event.target.closest('button')) {
      event.preventDefault();
      return;
    }

    state.libraryDragCampaignId = campaign.id;
    card.classList.add('is-dragging');
    if (!event.dataTransfer) return;
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('application/x-campaign-id', campaign.id);
    event.dataTransfer.setData('text/plain', campaign.id);
  });
  card.addEventListener('dragend', () => {
    state.libraryDragCampaignId = '';
    card.classList.remove('is-dragging');
    clearLibraryDropTargets();
  });
}

export function bindLibraryDropTarget(node, target) {
  node.addEventListener('dragover', (event) => {
    const sourceId = dragCampaignId(event);
    if (!sourceId || sourceId === target.targetId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    node.classList.add('is-drop-target');
  });

  node.addEventListener('dragleave', (event) => {
    if (event.relatedTarget instanceof Node && node.contains(event.relatedTarget)) return;
    node.classList.remove('is-drop-target');
  });

  node.addEventListener('drop', async (event) => {
    const sourceId = dragCampaignId(event);
    if (!sourceId || sourceId === target.targetId) return;
    event.preventDefault();
    event.stopPropagation();
    clearLibraryDropTargets();

    try {
      const result = await stackCampaignInLibrary(sourceId, target);
      if (result.collectionId) {
        state.libraryExpandedCollections.delete(result.collectionId);
        saveLibraryExpandedCollections();
      }
      await renderLibrary();
      showToast(result.changed ? 'Campaigns collected.' : 'Already in that collection.');
    } catch (error) {
      showToast(error.message || 'Could not collect campaigns.');
    } finally {
      state.libraryDragCampaignId = '';
    }
  });
}

export function dragCampaignId(event) {
  return (
    state.libraryDragCampaignId ||
    event.dataTransfer?.getData('application/x-campaign-id') ||
    event.dataTransfer?.getData('text/plain') ||
    ''
  );
}

export function clearLibraryDropTargets() {
  document
    .querySelectorAll('.is-drop-target')
    .forEach((node) => node.classList.remove('is-drop-target'));
}

export function buildCollectionRemoveButton(campaign) {
  const button = element('button', {
    className: 'library-card-collection-remove',
    type: 'button',
    text: 'Remove',
    title: 'Remove from collection',
    ariaLabel: 'Remove from collection',
  });
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await removeCampaignFromCollection(campaign.id);
      await renderLibrary();
      showToast('Removed from collection.');
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not update collection.');
    }
  });
  return button;
}

export function buildParkButton(campaign, parked) {
  const button = element('button', {
    className: 'library-card-park-button',
    type: 'button',
    title: parked ? 'Reactivate campaign' : 'Park campaign',
    ariaLabel: parked ? 'Reactivate campaign' : 'Park campaign',
    ariaPressed: parked ? 'true' : 'false',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await togglePark(campaign.id, !parked);
      await renderLibrary();
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not update park state.');
    }
  });
  return button;
}

export function buildDeleteMissingButton(campaign) {
  const button = element('button', {
    className: 'library-card-delete-button',
    type: 'button',
    title: 'Remove missing campaign',
    ariaLabel: 'Remove missing campaign from library',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';
  button.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    button.disabled = true;
    try {
      await deleteMissingCampaign(campaign.id);
      await renderLibrary();
      showToast('Missing campaign removed.');
    } catch (error) {
      button.disabled = false;
      showToast(error.message || 'Could not remove missing campaign.');
    }
  });
  return button;
}

export function buildDeleteButton(campaign) {
  const button = element('button', {
    className: 'library-card-trash-button',
    type: 'button',
    title: 'Delete campaign',
    ariaLabel: 'Delete campaign',
  });
  button.innerHTML =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M19 6l-1 14H6L5 6"/><path d="M10 11v5"/><path d="M14 11v5"/></svg>';
  button.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    showDeleteCampaignConfirm(campaign, button);
  });
  return button;
}

export function showDeleteCampaignConfirm(campaign, sourceButton) {
  const existing = document.getElementById('delete-campaign-modal');
  if (existing) existing.remove();

  const overlay = element('div', { className: 'nudge-confirm-modal', id: 'delete-campaign-modal' });
  const card = element('div', { className: 'nudge-confirm-card' });

  card.append(
    element('h3', {
      className: 'nudge-confirm-title',
      text: `Delete "${campaign.title || 'this campaign'}"?`,
    }),
    element('p', {
      className: 'nudge-confirm-desc',
      text: 'Moves the markdown file to your Trash and removes it from the library. You can put it back from Finder.',
    }),
  );

  const pathLine = element('p', { className: 'nudge-confirm-desc nudge-confirm-path' });
  pathLine.textContent = campaign.filePath || '';
  card.append(pathLine);

  const footer = element('div', { className: 'nudge-confirm-footer' });
  const cancelBtn = element('button', { className: 'button', text: 'Cancel', type: 'button' });
  const confirmBtn = element('button', {
    className: 'button button-danger',
    text: 'Delete',
    type: 'button',
  });

  cancelBtn.addEventListener('click', () => overlay.remove());
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    cancelBtn.disabled = true;
    confirmBtn.textContent = 'Deleting…';
    try {
      const res = await fetch('/api/registry', {
        method: 'DELETE',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: campaign.id, deleteFile: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Delete failed (${res.status})`);
      overlay.remove();
      await renderLibrary();
      showToast(data.trashed ? 'Campaign moved to Trash.' : 'Campaign removed.');
    } catch (error) {
      confirmBtn.disabled = false;
      cancelBtn.disabled = false;
      confirmBtn.textContent = 'Delete';
      showToast(error.message || 'Could not delete campaign.');
    }
  });

  footer.append(cancelBtn, confirmBtn);
  card.append(footer);

  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) overlay.remove();
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') overlay.remove();
  });

  overlay.append(card);
  document.body.append(overlay);
  confirmBtn.focus();
}

export async function togglePark(id, parked) {
  const response = await fetch('/api/registry/park', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, parked }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not update park state.');
  }
}

export async function toggleCollectionPark(collectionId, parked) {
  const response = await fetch('/api/registry/park', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ collectionId, parked }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not update stack park state.');
  }
}

export async function stackCampaignInLibrary(sourceId, target) {
  const body = target.targetCollectionId
    ? { action: 'stack', sourceId, targetCollectionId: target.targetCollectionId }
    : { action: 'stack', sourceId, targetId: target.targetId };
  const response = await fetch('/api/registry/collection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(payload.error || 'Could not collect campaigns.');
  }
  return payload;
}

export async function removeCampaignFromCollection(id) {
  const response = await fetch('/api/registry/collection', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', id }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not update collection.');
  }
}

export async function deleteMissingCampaign(id) {
  const response = await fetch('/api/registry', {
    method: 'DELETE',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'Could not remove missing campaign.');
  }
}

export function relativeHomePath(filePath, homeDir) {
  if (homeDir && filePath.startsWith(`${homeDir}/`)) {
    return `~${filePath.slice(homeDir.length)}`;
  }
  return filePath;
}

export function automateIndicator(status, extraClass = '') {
  const indicatorType = status === 'active'
    ? 'running'
    : status === 'completed'
      ? 'complete'
      : AUTOMATE_ATTENTION_STATUSES.has(status)
        ? 'attention'
        : 'idle';
  const className = [
    'automate-indicator',
    `automate-indicator--${indicatorType}`,
    extraClass,
  ].filter(Boolean).join(' ');
  const node = element('span', { className, ariaHidden: 'true' });
  if (indicatorType === 'attention') node.textContent = '!';
  if (indicatorType === 'complete') node.textContent = '✓';
  return node;
}

export function libraryAutomationIndicatorStatus(data) {
  const status = automateDisplayStatus(data);
  if (status === 'active') return 'active';
  if (AUTOMATE_SCHEDULED_STATUSES.has(status)) return status;
  if (AUTOMATE_ATTENTION_STATUSES.has(status)) return status;
  return null;
}

export function libraryAutomationCardStatus(data) {
  const status = libraryAutomationIndicatorStatus(data);
  if (!status) return null;

  const unitLabel = formatAutomateUnitLabel({ id: data.current_step_id });
  const step = unitLabel === 'Automation' ? '' : ` · ${unitLabel}`;
  const isChecking = status === 'stalled' && data.has_active_run;
  const isScheduled = AUTOMATE_SCHEDULED_STATUSES.has(status);
  const text = status === 'active'
    ? `Running${step}`
    : isScheduled
      ? `Scheduled${step}`
    : isChecking
      ? `Checking${step}`
      : `Needs attention${step}`;

  return {
    status,
    text,
    title: [data.current_step_name, formatExecutionContext(data.execution), data.attention?.title]
      .filter(Boolean)
      .join('\n'),
    attention: status === 'active' && data.attention?.level === 'history' ? data.attention : null,
    progress: data.progress ?? null,
    execution: data.execution ?? null,
  };
}

export function formatExecutionContext(execution) {
  if (!execution || typeof execution !== 'object') return '';
  const branch = String(execution.branch || '').trim();
  if (execution.kind === 'worktree') return branch ? `Worktree · ${branch}` : 'Worktree';
  if (execution.kind === 'branch') return branch ? `Branch · ${branch}` : 'Branch';
  return '';
}

export function buildLibraryAutomationStatus(summary) {
  const node = element('span', { className: 'library-card-automate-status' });
  node.append(
    automateIndicator(summary.status),
    element('span', { className: 'library-card-automate-text', text: summary.text }),
  );
  if (summary.attention) {
    const warning = automateIndicator('failed', 'library-card-automate-warning');
    warning.title = summary.attention.title || summary.attention.label || 'Warning history';
    node.append(warning);
  }
  node.title = summary.title || summary.text;
  return node;
}

export function updateLibraryDots() {
  const collectionNodes = document.querySelectorAll(
    '.library-collection-card[data-campaign-ids], .library-collection-section[data-campaign-ids]',
  );
  for (const node of collectionNodes) {
    updateLibraryCollectionIndicator(node);
  }

  const cards = document.querySelectorAll('.library-card[data-campaign-id]');
  for (const card of cards) {
    card.querySelector('.library-card-automate-dot')?.remove();
    card.querySelector('.library-card-automate-status')?.remove();
    card.querySelector('.library-card-away-button')?.remove();
    if (card.classList.contains('library-collection-card') || card.classList.contains('complete')) continue;
    const link = card.querySelector('.library-card-link');
    if (!link) continue;
    const href = link.getAttribute('href') || '';
    const match = href.match(/[?&]id=([^&]+)/);
    if (!match) continue;
    const id = decodeURIComponent(match[1]);
    const entry = automateState.bulk[id];

    const cardStatus = libraryAutomationCardStatus(entry);
    const title = card.querySelector('.library-card-title')?.textContent?.trim() || awayHumanizeId(id);
    if (!cardStatus) {
      card.dataset.displayState = card.classList.contains('parked')
        ? 'sleeping'
        : card.classList.contains('missing')
          ? 'missing'
          : 'idle';
      continue;
    }

    const status = buildLibraryCardStatus(cardStatus, id, title);
    card.dataset.displayState = cardStatus.status === 'active'
      ? 'running'
      : AUTOMATE_SCHEDULED_STATUSES.has(cardStatus.status)
        ? 'running'
        : 'needs-attention';
    ensureLibraryCardFallbackLogo(card, title);
    const time = link.querySelector('.library-card-time');
    if (time) {
      link.insertBefore(status, time);
    } else {
      link.append(status);
    }
  }

  updateAwayAllButton();
}

export function ensureLibraryCardFallbackLogo(card, title) {
  if (card.classList.contains('has-logo') || card.querySelector('.library-card-logo')) return;
  const chrome = card.querySelector('.library-card-chrome');
  if (!chrome) return;
  chrome.prepend(buildFallbackLogo({ title }));
  card.classList.add('has-logo');
}

export function updateLibraryCollectionIndicator(node) {
  node
    .querySelectorAll('.library-collection-automate-status, .library-collection-away-button')
    .forEach((existing) => existing.remove());

  const ids = (node.dataset.campaignIds || '').split(/\s+/).filter(Boolean);
  const summary = collectionAutomationSummary(ids);
  if (!summary) return;

  const status = element('span', { className: 'library-collection-automate-status' });
  status.append(
    automateIndicator(summary.indicatorStatus),
    element('span', { text: summary.text }),
  );
  status.title = summary.title;

  // Away from the stack while any campaign in it is running. Pass all ids so
  // the overlay can split active windows from ignored attention campaigns.
  if (awayActiveIdsIn(ids).length) {
    const stackTitle = node.querySelector('.library-collection-title, .library-card-title')?.textContent?.trim() || 'Stack';
    status.append(awayEntryButton('', () => openAwayMode({ mode: 'stack', ids, title: stackTitle }), 'library-collection-away-button'));
  }

  if (node.classList.contains('library-collection-section')) {
    const header = node.querySelector('.library-collection-header');
    const collapse = header?.querySelector('.library-collection-collapse');
    if (header && collapse) {
      header.insertBefore(status, collapse);
      return;
    }
  }

  const time = node.querySelector('.library-card-time');
  if (time) {
    node.insertBefore(status, time);
  } else {
    node.append(status);
  }
}

export function collectionAutomationSummary(campaignIds) {
  const counts = {
    active: 0,
    scheduled: 0,
    attention: 0,
  };
  const titles = [];

  for (const id of campaignIds) {
    const entry = automateState.bulk[id];
    const status = libraryAutomationIndicatorStatus(entry);
    if (!status) continue;

    if (status === 'active') {
      counts.active += 1;
    } else if (AUTOMATE_SCHEDULED_STATUSES.has(status)) {
      counts.scheduled += 1;
    } else {
      counts.attention += 1;
    }
    titles.push(entry?.current_step_name || status);
  }

  if (counts.active === 0 && counts.scheduled === 0 && counts.attention === 0) return null;

  const parts = [];
  if (counts.active > 0) {
    parts.push(`${counts.active} running`);
  }
  if (counts.scheduled > 0) {
    parts.push(`${counts.scheduled} scheduled`);
  }
  if (counts.attention > 0) {
    parts.push(`${counts.attention} attention`);
  }

  return {
    indicatorStatus: counts.active > 0 ? 'active' : counts.attention > 0 ? 'failed' : 'queued',
    text: parts.join(' · '),
    title: titles.join('\n'),
  };
}

export function formatAutomateUnitLabel(unit) {
  const id = unit?.id ? String(unit.id) : '';
  if (!id) return 'Automation';
  if (/^\d+(?:\.\d+)*$/.test(id)) return `Step ${id}`;
  return id
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => `${part.charAt(0).toUpperCase()}${part.slice(1)}`)
    .join(' ');
}

/* ---- Library collection expand/collapse state (localStorage) ---- */
const LIBRARY_COLLECTIONS_EXPANDED_KEY = "campaigns-library-collections-expanded:v1";

export function loadLibraryExpandedCollections() {
  try {
    const raw = localStorage.getItem(LIBRARY_COLLECTIONS_EXPANDED_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((id) => typeof id === 'string' && id.trim() !== ''));
  } catch {
    return new Set();
  }
}

export function saveLibraryExpandedCollections() {
  try {
    localStorage.setItem(
      LIBRARY_COLLECTIONS_EXPANDED_KEY,
      JSON.stringify([...state.libraryExpandedCollections]),
    );
  } catch {
    /* ignore */
  }
}
