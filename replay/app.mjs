import { renderReadOnlyBoard } from '../public/modules/render.mjs';
import { state } from '../public/modules/state.mjs';

const replay = globalThis.__CAMPAIGNS_REPLAY__;
const controls = {
  board: document.querySelector('#document'),
  event: document.querySelector('#replay-event'),
  eventDetail: document.querySelector('#replay-event-detail'),
  play: document.querySelector('#replay-play'),
  progress: document.querySelector('#progress-fill'),
  progressLabel: document.querySelector('#progress-label'),
  sequence: document.querySelector('#replay-sequence'),
  speed: document.querySelector('#replay-speed'),
  status: document.querySelector('#replay-status'),
  timeline: document.querySelector('#replay-timeline'),
};

state.serverBacked = false;
state.capabilities.runners = [{
  id: 'claude',
  label: 'Claude Code',
  models: [{ id: 'claude-opus-4-8', label: 'Fable 5' }],
}];

let index = 0;
let timer = null;

controls.timeline.max = String(replay.points.length - 1);
controls.timeline.addEventListener('input', () => {
  pause();
  show(Number(controls.timeline.value));
});
controls.play.addEventListener('click', () => (timer ? pause() : play()));
controls.speed.addEventListener('change', () => {
  if (timer) {
    pause();
    play();
  }
});
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement) return;
  if (event.key === ' ') {
    event.preventDefault();
    timer ? pause() : play();
  } else if (event.key === 'ArrowLeft') {
    pause();
    show(index - 1);
  } else if (event.key === 'ArrowRight') {
    pause();
    show(index + 1);
  }
});

const requestedPoint = Number.parseInt(location.hash.slice(1), 10);
show(Number.isInteger(requestedPoint) ? requestedPoint : 0);
globalThis.__CAMPAIGNS_REPLAY_READY__ = true;

function show(nextIndex) {
  index = Math.max(0, Math.min(replay.points.length - 1, nextIndex));
  const point = replay.points[index];
  const view = renderReadOnlyBoard({
    filePath: 'examples/hello-run.md',
    markdown: point.markdown,
    readOnly: true,
    target: controls.board,
  });
  const percent = view.stats.total === 0 ? 0 : Math.round((view.stats.done / view.stats.total) * 100);
  controls.progress.style.width = `${percent}%`;
  controls.progressLabel.textContent = `${view.stats.done} of ${view.stats.total} done`;
  controls.event.textContent = eventLabel(point.event);
  controls.eventDetail.textContent = point.step_id
    ? `Step ${point.step_id} · event ${point.sequence}`
    : `Journal event ${point.sequence}`;
  controls.sequence.textContent = `${index + 1} / ${replay.points.length}`;
  controls.status.textContent = statusLabel(point);
  controls.status.dataset.status = point.run_status;
  controls.timeline.value = String(index);
  controls.timeline.setAttribute('aria-valuetext', `${controls.event.textContent}, ${controls.sequence.textContent}`);
  history.replaceState(null, '', `#${index}`);
  document.title = `${controls.event.textContent} · Campaigns replay`;
}

function play() {
  if (index === replay.points.length - 1) show(0);
  controls.play.textContent = 'Pause';
  controls.play.setAttribute('aria-label', 'Pause replay');
  const interval = 1_200 / Number(controls.speed.value);
  timer = window.setInterval(() => {
    if (index >= replay.points.length - 1) {
      pause();
      return;
    }
    show(index + 1);
  }, interval);
}

function pause() {
  window.clearInterval(timer);
  timer = null;
  controls.play.textContent = 'Play';
  controls.play.setAttribute('aria-label', 'Play replay');
}

function eventLabel(event) {
  return ({
    document_transition: 'Board updated',
    run_initialized: 'Run initialized',
    state_persisted: 'Engine state persisted',
  })[event] || event.replaceAll('_', ' ');
}

function statusLabel(point) {
  if (point.review_status === 'approved') return 'Final review approved';
  if (point.review_status === 'running') return 'Final review running';
  if (point.run_status === 'awaiting_review') return 'Awaiting final review';
  if (point.step_id) return `Step ${point.step_id} · ${point.run_status}`;
  return point.run_status.replaceAll('_', ' ');
}
