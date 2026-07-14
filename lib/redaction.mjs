import { writeFileAtomic } from './registry.mjs';

export const REDACTION_MASK = '[REDACTED]';

const SENSITIVE_KEY = /(?:secret|token|password|passwd|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|database[_-]?url|db[_-]?url|connection[_-]?string)/i;
const TEXT_RULES = [
  {
    pattern: /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gi,
    replace: REDACTION_MASK,
  },
  {
    pattern: /(^|[^A-Za-z0-9_])((?:export\s+)?[A-Za-z][A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|database[_-]?url|db[_-]?url|connection[_-]?string)[A-Za-z0-9_.-]*)\s*=\s*(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n]+)/gim,
    replace: (_match, boundary, key) => `${boundary}${key}=${REDACTION_MASK}`,
  },
  {
    pattern: /((?:"|')?[A-Za-z][A-Za-z0-9_.-]*(?:secret|token|password|passwd|api[_-]?key|auth|credential|private[_-]?key|access[_-]?key|database[_-]?url|db[_-]?url|connection[_-]?string)[A-Za-z0-9_.-]*(?:"|')?\s*:\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,}\]\r\n]+)/gim,
    replace: (_match, prefix) => `${prefix}"${REDACTION_MASK}"`,
  },
  {
    pattern: /\b((?:postgres(?:ql)?|mysql|mariadb|mongodb(?:\+srv)?|redis(?:s)?|amqp(?:s)?|libsql):\/\/)[^\s"'`<>]+/gi,
    replace: (_match, scheme) => `${scheme}${REDACTION_MASK}`,
  },
  {
    pattern: /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^@\s/]+@[^\s"'`<>]+/gi,
    replace: (_match, scheme) => `${scheme}${REDACTION_MASK}`,
  },
  {
    pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi,
    replace: `Bearer ${REDACTION_MASK}`,
  },
  {
    pattern: /([?&](?:access[_-]?token|auth[_-]?token|api[_-]?key|token|password)=)[^&#\s"'`<>]+/gi,
    replace: (_match, prefix) => `${prefix}${REDACTION_MASK}`,
  },
  {
    pattern: /(--(?:api-key|token|password|secret)\s+)[^\s"'`<>]+/gi,
    replace: (_match, prefix) => `${prefix}${REDACTION_MASK}`,
  },
  {
    pattern: /\b(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,}|AKIA[A-Z0-9]{16})\b/g,
    replace: REDACTION_MASK,
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    replace: REDACTION_MASK,
  },
];

export function redactText(value) {
  let text = String(value ?? '');
  for (const rule of TEXT_RULES) text = text.replace(rule.pattern, rule.replace);
  return text;
}

export function redactValue(value, key = '') {
  if (typeof value === 'string') {
    return SENSITIVE_KEY.test(key) ? REDACTION_MASK : redactText(value);
  }
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([entryKey, entryValue]) => [
        entryKey,
        redactValue(entryValue, entryKey),
      ]),
    );
  }
  return value;
}

export function createStreamingRedactor() {
  let pending = '';
  return {
    push(chunk) {
      pending += String(chunk ?? '');
      const boundary = Math.max(pending.lastIndexOf('\n'), pending.lastIndexOf('\r'));
      if (boundary < 0) return '';
      const complete = pending.slice(0, boundary + 1);
      pending = pending.slice(boundary + 1);
      return redactText(complete);
    },
    flush() {
      const complete = redactText(pending);
      pending = '';
      return complete;
    },
  };
}

export async function writeRedactedFile(filePath, contents) {
  await writeFileAtomic(filePath, redactText(contents));
}

export async function writeRedactedState(statePath, state) {
  await writeFileAtomic(statePath, `${JSON.stringify(redactValue(state), null, 2)}\n`);
}
