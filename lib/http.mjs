// Small HTTP helpers shared across the server's request handlers: JSON
// responses, bounded JSON body reading, a status-carrying error, and static
// file serving. Pure Node — no registry or app state — so `publicDir` is passed
// in rather than reached for.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import path from 'node:path';

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.md', 'text/markdown; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.webp', 'image/webp'],
]);

export function sendJson(response, statusCode, body) {
  response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(body));
}

export async function readJsonBody(request) {
  const chunks = [];
  let byteLength = 0;

  for await (const chunk of request) {
    byteLength += chunk.length;

    if (byteLength > 2_000_000) {
      throw httpError(413, 'Request body is too large.');
    }

    chunks.push(chunk);
  }

  const rawBody = Buffer.concat(chunks).toString('utf8');
  try {
    return rawBody ? JSON.parse(rawBody) : {};
  } catch {
    throw httpError(400, 'Request body is not valid JSON.');
  }
}

export function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function sendStatic(publicDir, urlPath, response, headOnly) {
  const normalizedPath = urlPath === '/' ? '/index.html' : decodeURIComponent(urlPath);
  const requestedPath = path.normalize(normalizedPath).replace(/^(\.\.[/\\])+/, '');
  const staticPath = path.join(publicDir, requestedPath);

  if (!staticPath.startsWith(publicDir)) {
    sendJson(response, 403, { error: 'Forbidden' });
    return;
  }

  try {
    const details = await stat(staticPath);
    const extension = path.extname(staticPath);

    response.writeHead(200, {
      'content-length': details.size,
      'content-type': mimeTypes.get(extension) ?? 'application/octet-stream',
      // Always revalidate so UI updates land on the next reload instead of
      // being pinned by the browser's heuristic cache.
      'cache-control': 'no-cache',
    });

    if (headOnly) {
      response.end();
      return;
    }

    const stream = createReadStream(staticPath);
    stream.on('error', () => response.destroy());
    stream.pipe(response);
  } catch {
    sendJson(response, 404, { error: 'Not found' });
  }
}
