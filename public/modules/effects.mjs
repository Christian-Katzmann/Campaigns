// Celebration and ambient feedback: theme application, the completion chord and
// tick (Web Audio), confetti, the phase-complete banner, and the mac/ntfy/webhook
// notification delivery — plus the phase-completion detector that fires them.
//
// A leaf module: it reads shared state and builds DOM, but nothing here calls back
// into the board renderer or the feature modules, so it sits just above dom/state.

import {
  automateState,
  elements,
  isAutomateRunning,
  isAutomateScheduled,
  state,
} from './state.mjs';
import { element, fileNameFromPath } from './dom.mjs';
import { normalizeTheme } from '../lib/prefs.mjs';

export const NTFY_TOPIC_REGEX = /^[A-Za-z0-9_-]{3,64}$/;

export function applyTheme(theme) {
  const themes = [
    'theme-blueprint',
    'theme-cyberpunk',
    'theme-forest',
    'theme-graphite',
    'theme-obsidian',
    'theme-signal',
    'theme-sunset',
  ];
  themes.forEach(cls => document.body.classList.remove(cls));
  const selectedTheme = normalizeTheme(theme);
  if (selectedTheme !== 'default') {
    document.body.classList.add(`theme-${selectedTheme}`);
  }
  syncThemeColorMeta();
}

// Keep the browser/PWA chrome color in step with the resolved page background,
// so the title bar doesn't stay paper-white over a dark theme.
export function syncThemeColorMeta() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!meta) return;
  const page = getComputedStyle(document.body).getPropertyValue('--page').trim();
  if (page) meta.setAttribute('content', page);
}

let audioCtx = null;

export function playAudioFeedback(type) {
  if (!state.prefs.soundEffectsEnabled) return;

  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }

    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);

    if (type === 'tick') {
      osc.type = 'sine';
      osc.frequency.setValueAtTime(600, audioCtx.currentTime);
      osc.frequency.exponentialRampToValueAtTime(150, audioCtx.currentTime + 0.05);

      gain.gain.setValueAtTime(0.08, audioCtx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.05);

      osc.start();
      osc.stop(audioCtx.currentTime + 0.05);
    } else if (type === 'success') {
      const now = audioCtx.currentTime;
      const notes = [261.63, 329.63, 392.00, 523.25];
      
      notes.forEach((freq, idx) => {
        const oscNode = audioCtx.createOscillator();
        const gainNode = audioCtx.createGain();
        
        oscNode.type = 'triangle';
        oscNode.frequency.setValueAtTime(freq, now + idx * 0.08);
        
        gainNode.gain.setValueAtTime(0, now);
        gainNode.gain.linearRampToValueAtTime(0.12, now + idx * 0.08 + 0.01);
        gainNode.gain.exponentialRampToValueAtTime(0.001, now + idx * 0.08 + 0.4);
        
        oscNode.connect(gainNode);
        gainNode.connect(audioCtx.destination);
        
        oscNode.start(now + idx * 0.08);
        oscNode.stop(now + idx * 0.08 + 0.45);
      });
    }
  } catch (error) {
    console.warn('Web Audio playback failed:', error);
  }
}

let confettiActive = false;
let confettiParticles = [];

export function triggerConfetti(intensity = 'phase') {
  if (!state.prefs.celebrationsEnabled) return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  if (confettiActive) return;

  const canvas = document.querySelector('#confetti-canvas');
  if (!canvas) return;

  const ctx = canvas.getContext('2d');
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;

  const handleResize = () => {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  };
  window.addEventListener('resize', handleResize);

  confettiParticles = [];
  const particleCount = intensity === 'campaign' ? 110 : 44;
  const colors = confettiPalette();
  for (let i = 0; i < particleCount; i++) {
    confettiParticles.push({
      x: Math.random() * canvas.width,
      y: intensity === 'campaign'
        ? Math.random() * canvas.height - canvas.height
        : Math.random() * -160,
      r: Math.random() * 5 + 3,
      d: Math.random() * canvas.height,
      color: colors[Math.floor(Math.random() * colors.length)],
      tilt: Math.random() * 10 - 5,
      tiltAngleIncremental: Math.random() * 0.07 + 0.02,
      tiltAngle: 0
    });
  }

  confettiActive = true;

  let frameCount = 0;
  const maxFrames = intensity === 'campaign' ? 170 : 95;

  function draw() {
    if (!confettiActive) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    let living = false;
    for (let i = 0; i < confettiParticles.length; i++) {
      const p = confettiParticles[i];
      p.tiltAngle += p.tiltAngleIncremental;
      p.y += (Math.cos(p.d) + 3 + p.r / 2) * 0.7;
      p.x += Math.sin(p.tiltAngle) * 0.5;
      p.tilt = Math.sin(p.tiltAngle - (i / 3)) * 15;

      if (p.y < canvas.height) {
        living = true;
      }

      ctx.beginPath();
      ctx.lineWidth = p.r;
      ctx.strokeStyle = p.color;
      ctx.moveTo(p.x + p.tilt + p.r / 2, p.y);
      ctx.lineTo(p.x + p.tilt, p.y + p.tilt + p.r / 2);
      ctx.stroke();
    }

    frameCount++;
    if (living && frameCount < maxFrames) {
      requestAnimationFrame(draw);
    } else {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      confettiActive = false;
      window.removeEventListener('resize', handleResize);
    }
  }

  requestAnimationFrame(draw);
}

export function confettiPalette() {
  const styles = getComputedStyle(document.body);
  const fromVar = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return [
    fromVar('--accent', '#0b66d8'),
    fromVar('--ink', '#121212'),
    fromVar('--done', '#a9a49c'),
    '#f0c36a',
    '#7fb7a6',
  ];
}

export async function sendConfiguredNotifications(title, message) {
  const deliveries = [];
  const ntfyTopic = NTFY_TOPIC_REGEX.test(state.prefs.ntfyTopic || '')
    ? state.prefs.ntfyTopic
    : '';

  if (state.prefs.macNotificationsEnabled) {
    deliveries.push(
      fetch('/api/notify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, message }),
      }).then((response) => {
        if (!response.ok) throw new Error(`Mac notification failed (${response.status}).`);
        return response;
      }),
    );
  }

  if (ntfyTopic || state.prefs.webhookUrl) {
    deliveries.push(
      postRemoteNotification({
        title,
        message,
        ntfyTopic,
        webhookUrl: state.prefs.webhookUrl,
      }),
    );
  }

  const results = await Promise.allSettled(deliveries);
  for (const result of results) {
    if (result.status === 'rejected') {
      console.warn('Notification delivery failed:', result.reason);
    }
  }
}

export async function postRemoteNotification(payload) {
  const response = await fetch('/api/push', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  if (response.ok) return response.json().catch(() => ({ ok: true }));

  let errorMessage = 'Notification failed.';
  try {
    const errorPayload = await response.json();
    errorMessage = errorPayload.error || errorPayload.failures?.[0]?.error || errorMessage;
  } catch {
    /* keep generic message */
  }
  throw new Error(errorMessage);
}

export function campaignDisplayTitle() {
  const heading = elements.documentTitle?.textContent?.trim();
  return heading || fileNameFromPath(state.filePath) || 'Campaign';
}

export async function handleCompletionEffects(prevPhases, nextPhases, prevStats, nextStats) {
  let completedPhase = null;
  for (const nextP of nextPhases) {
    const prevP = prevPhases.find(p => p.anchorId === nextP.anchorId);
    if (nextP.total > 0 && nextP.done === nextP.total) {
      if (!prevP || prevP.done < prevP.total) {
        completedPhase = nextP;
      }
    }
  }

  const isCampaignCompleted = nextStats.total > 0 && nextStats.done === nextStats.total && (prevStats.done < prevStats.total);

  if (isCampaignCompleted) {
    playAudioFeedback('success');
    triggerConfetti('campaign');
    if (shouldSendBrowserCompletionNotification()) {
      const message = `${campaignDisplayTitle()} is 100% complete.`;
      sendConfiguredNotifications('Campaign complete', message);
    }
  } else if (completedPhase) {
    playAudioFeedback('success');
    triggerConfetti('phase');
    if (shouldSendBrowserCompletionNotification()) {
      const message = `Phase "${completedPhase.title}" is now complete (${completedPhase.done}/${completedPhase.total} tasks).`;
      sendConfiguredNotifications('Phase complete', message);
    }
  }
}

export function shouldSendBrowserCompletionNotification() {
  return !isAutomateRunning(automateState.current) && !isAutomateScheduled(automateState.current);
}

export function showPhaseBanner(phase) {
  if (!elements.phaseBanner) return;
  if (state.phaseBannerTimer) clearTimeout(state.phaseBannerTimer);

  elements.phaseBanner.replaceChildren(
    element('strong', { text: phase.title }),
    element('span', { className: 'phase-banner-meta', text: `${phase.done} / ${phase.total} done` }),
    element('button', {
      ariaLabel: 'Dismiss',
      className: 'phase-banner-close',
      text: '×',
      type: 'button',
    }),
  );
  elements.phaseBanner.querySelector('.phase-banner-close').addEventListener('click', hidePhaseBanner);

  elements.phaseBanner.classList.add('visible');
  state.phaseBannerTimer = window.setTimeout(hidePhaseBanner, 6000);
}

export function hidePhaseBanner() {
  if (!elements.phaseBanner) return;
  elements.phaseBanner.classList.remove('visible');
  if (state.phaseBannerTimer) {
    clearTimeout(state.phaseBannerTimer);
    state.phaseBannerTimer = null;
  }
}

export function detectPhaseCompletions(phases) {
  const previous = state.lastPhaseSnapshot;
  const snapshot = {};
  for (const phase of phases) {
    snapshot[phase.anchorId] = { done: phase.done, total: phase.total };
    if (!previous) continue;
    const before = previous[phase.anchorId];
    if (
      before &&
      phase.total > 0 &&
      before.done < before.total &&
      phase.done === phase.total
    ) {
      showPhaseBanner(phase);
    }
  }
  state.lastPhaseSnapshot = snapshot;
}
