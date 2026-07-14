import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

import {
  REDACTION_MASK,
  redactAndCapText,
  createStreamingRedactor,
  redactText,
  writeRedactedState,
} from '../lib/redaction.mjs';

const SECRET_VALUES = [
  'audit-auth-value',
  'audit-db-value',
  'db-password',
  'bearer.audit.token-123',
];

test('redacts env assignments, connection strings, bearer credentials, and token shapes', () => {
  const raw = [
    'AUTH_SECRET=audit-auth-value',
    'TURSO_DATABASE_URL="libsql://audit.invalid?authToken=audit-db-value"',
    'postgres://user:db-password@db.invalid/app',
    'Authorization: Bearer bearer.audit.token-123',
    'github_pat_abcdefghijklmnopqrstuvwxyz123456',
  ].join('\n');
  const redacted = redactText(raw);

  for (const secret of SECRET_VALUES) assert.doesNotMatch(redacted, new RegExp(secret));
  assert.match(redacted, /AUTH_SECRET=\[REDACTED\]/);
  assert.match(redacted, /TURSO_DATABASE_URL=\[REDACTED\]/);
  assert.match(redacted, /postgres:\/\/\[REDACTED\]/);
  assert.match(redacted, /Bearer \[REDACTED\]/);
  assert.match(redacted, new RegExp(REDACTION_MASK.replace(/[\[\]]/g, '\\$&')));
});

test('redacts before capping persisted command output', () => {
  const collapsedByRedaction = `AUTH_SECRET=${'s'.repeat(100)}`;
  const collapsed = redactAndCapText(collapsedByRedaction, 80);
  assert.equal(collapsed, `AUTH_SECRET=${REDACTION_MASK}`);
  assert.doesNotMatch(collapsed, /TRUNCATED/);

  const capped = redactAndCapText(`${'x'.repeat(100)}\nAUTH_SECRET=tail-secret`, 80);
  assert.equal(capped.length, 80);
  assert.match(capped, /^\[TRUNCATED: output capped at 80 characters\]/);
  assert.match(capped, new RegExp(REDACTION_MASK.replace(/[\[\]]/g, '\\$&')));
  assert.doesNotMatch(capped, /tail-secret/);
});

test('streaming redaction holds incomplete lines across mixed output chunks', () => {
  const stream = createStreamingRedactor();
  let persisted = '';
  persisted += stream.push('AUTH_SEC');
  persisted += stream.push('RET=split-secret postgres://user:split-pass@db.invalid/app Bear');
  persisted += stream.push('er split.bearer.token\nclean line\n');
  persisted += stream.flush();

  assert.doesNotMatch(persisted, /split-secret|split-pass|split\.bearer\.token/);
  assert.match(persisted, /AUTH_SECRET=\[REDACTED\]/);
  assert.match(persisted, /postgres:\/\/\[REDACTED\]/);
  assert.match(persisted, /Bearer \[REDACTED\]/);
  assert.match(persisted, /clean line/);
});

test('state persistence masks history messages, details, and failure tails', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'campaigns-redaction-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const statePath = path.join(root, 'state.json');
  await writeRedactedState(statePath, {
    history: [{
      message: 'AUTH_SECRET=audit-auth-value',
      details: {
        access_token: 'audit-db-value',
        failure: {
          output_tail: 'postgres://user:db-password@db.invalid/app Bearer bearer.audit.token-123',
        },
      },
    }],
  });
  const persisted = await readFile(statePath, 'utf8');
  const state = JSON.parse(persisted);

  for (const secret of SECRET_VALUES) assert.doesNotMatch(persisted, new RegExp(secret));
  assert.equal(state.history[0].details.access_token, REDACTION_MASK);
  assert.match(state.history[0].message, /AUTH_SECRET=\[REDACTED\]/);
  assert.match(state.history[0].details.failure.output_tail, /postgres:\/\/\[REDACTED\]/);
});
