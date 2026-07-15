import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (file) => readFile(new URL(`../${file}`, import.meta.url), 'utf8');

test('dynamic board, library, and automation dialogs use the shared focus lifecycle', async () => {
  const [board, library, automation, settings, worktrees] = await Promise.all([
    read('public/modules/board.mjs'),
    read('public/modules/library.mjs'),
    read('public/modules/automate-drawer.mjs'),
    read('public/modules/settings.mjs'),
    read('public/modules/worktrees.mjs'),
  ]);

  assert.match(board, /manageDialogFocus\(overlay, \{ initialFocus: runnerSelect \}\)/);
  assert.match(board, /manageDialogFocus\(elements\.conflictModal/);
  assert.match(library, /manageDialogFocus\(overlay/);
  assert.match(automation, /manageDialogFocus\(overlay/);
  assert.doesNotMatch(automation, /if \(e\.key === 'Escape'\) overlay\.remove\(\)/);
  assert.match(settings, /event\.defaultPrevented \|\| drawer\.hidden/);
  assert.match(settings, /trapDialogFocus\(event, drawer\)/);
  assert.match(worktrees, /trapDialogFocus\(event, panel\)/);
});

test('primary controls have restrained live regions, names, and keyboard resize semantics', async () => {
  const html = await read('public/index.html');

  assert.match(html, /<article id="document" class="document"><\/article>/);
  assert.match(html, /id="sound-toggle"[^>]+aria-label="Sound"/);
  assert.match(html, /id="celebration-toggle"[^>]+aria-label="Completion burst"/);
  assert.match(html, /id="mac-notify-toggle"[^>]+aria-label="Mac alerts"/);
  assert.match(html, /class="automate-drawer-resize"[^>]+tabindex="0"[^>]+aria-orientation="vertical"/);
});

test('notification escalation policy controls have explicit labels', async () => {
  const html = await read('public/index.html');
  for (const id of ['digest-mode-select', 'quiet-hours-start', 'quiet-hours-end']) {
    assert.match(html, new RegExp(`<label[^>]+for="${id}"`));
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /<legend>[\s\S]*Always page[\s\S]*<\/legend>/);
  assert.equal((html.match(/data-page-always/g) ?? []).length, 5);
});

test('reduced motion skips celebrations and removes interface animation', async () => {
  const [effects, styles] = await Promise.all([
    read('public/modules/effects.mjs'),
    read('public/styles.css'),
  ]);

  assert.match(effects, /matchMedia\('\(prefers-reduced-motion: reduce\)'\)\.matches\) return/);
  const reducedMotion = styles.slice(styles.lastIndexOf('@media (prefers-reduced-motion: reduce)'));
  assert.match(reducedMotion, /animation: none !important/);
  assert.match(reducedMotion, /transition: none !important/);
});

test('security guidance ships with the package', async () => {
  const packageJson = JSON.parse(await read('package.json'));
  assert.ok(packageJson.files.includes('SECURITY.md'));
  assert.ok(packageJson.files.includes('docs/threat-model.md'));
});
