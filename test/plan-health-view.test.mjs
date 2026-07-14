import assert from 'node:assert/strict';
import { test } from 'node:test';

test('plan-health strip renders findings and disappears when clean', async () => {
  const originalDocument = globalThis.document;
  globalThis.document = fakeDocument();
  try {
    const { renderPlanHealthStrip } = await import('../public/modules/plan-health-view.mjs');
    const strip = renderPlanHealthStrip([
      {
        anchorId: 'step-1-1-work',
        fixHint: 'Add observable acceptance criteria.',
        message: 'Step 1.1 has no ACCEPTANCE section.',
        severity: 'error',
        stepId: '1.1',
      },
    ]);

    assert.equal(renderPlanHealthStrip([]), null);
    assert.match(strip.outerHTML, /1 finding/);
    assert.match(strip.outerHTML, /plan-health-finding--error/);
    assert.match(strip.outerHTML, /data-action="jump-to-step"/);
    assert.match(strip.outerHTML, /data-step-id="step-1-1-work"/);
  } finally {
    globalThis.document = originalDocument;
  }
});

function fakeDocument() {
  return {
    createElement(tagName) { return new FakeElement(tagName); },
    querySelector() { return null; },
  };
}

class FakeElement {
  constructor(tagName) {
    this.tagName = tagName;
    this.attributes = {};
    this.children = [];
    this.className = '';
    this.dataset = {};
    this.textContent = '';
  }

  append(...children) {
    this.children.push(...children);
  }

  setAttribute(name, value) {
    this.attributes[name] = String(value);
  }

  get outerHTML() {
    const attributes = { ...this.attributes };
    if (this.className) attributes.class = this.className;
    for (const [key, value] of Object.entries(this.dataset)) {
      const name = key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      attributes[`data-${name}`] = value;
    }
    if (this.href) attributes.href = this.href;
    const attrs = Object.entries(attributes)
      .map(([name, value]) => ` ${name}="${escapeHtml(value)}"`)
      .join('');
    const body = escapeHtml(this.textContent)
      + this.children.map((child) => child?.outerHTML ?? escapeHtml(String(child))).join('');
    return `<${this.tagName}${attrs}>${body}</${this.tagName}>`;
  }
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}
