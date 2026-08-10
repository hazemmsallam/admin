#!/usr/bin/env node
/**
 * Local server for the CSAT MSISDN tool.
 *
 * It does two things:
 *   1. serves the pages in public/ and the shared modules in src/
 *   2. relays survey submissions from the browser to the CSAT endpoint
 *
 * The relay exists because the CSAT service is plain HTTP on an internal host
 * and sends no CORS headers, so a browser cannot call it directly. Requests
 * made from Node have no such restriction.
 *
 *   node server.js [--port 8787] [--host 127.0.0.1]
 *
 * Environment:
 *   PORT, HOST                 listen address (defaults 8787 / 127.0.0.1)
 *   CSAT_ALLOWED_HOSTS         extra relay targets, comma separated
 *   CSAT_ALLOW_ANY_HOST=1      relay anywhere (off by default)
 */

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG, createFetchTransport } from './src/csat.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(ROOT, 'public');
const SRC_DIR = path.join(ROOT, 'src');

const args = parseArgs(process.argv.slice(2));
const PORT = Number(args.port || process.env.PORT || 8787);
const HOST = args.host || process.env.HOST || '127.0.0.1';

const ALLOW_ANY_HOST = process.env.CSAT_ALLOW_ANY_HOST === '1';
const ALLOWED_HOSTS = new Set(
  [
    new URL(DEFAULT_CONFIG.baseUrl).hostname,
    'localhost',
    '127.0.0.1',
    ...(process.env.CSAT_ALLOWED_HOSTS || '').split(',').map((h) => h.trim()).filter(Boolean),
  ].map((h) => h.toLowerCase()),
);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

const transport = createFetchTransport();

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (req.method === 'GET' && url.pathname === '/api/config') return sendJson(res, 200, publicConfig());
    if (req.method === 'GET' && url.pathname === '/api/health') return sendJson(res, 200, { ok: true });
    if (url.pathname === '/api/submit') {
      if (req.method !== 'POST') return sendJson(res, 405, { error: 'Use POST for /api/submit.' });
      return await handleSubmit(req, res);
    }
    if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(url.pathname, res);

    return sendJson(res, 405, { error: `Unsupported method ${req.method}.` });
  } catch (error) {
    sendJson(res, 500, { error: error.message || 'Internal error' });
  }
});

server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' ? 'localhost' : HOST;
  process.stdout.write(
    `CSAT MSISDN tool listening on http://${shown}:${PORT}\n` +
    `Relay targets: ${ALLOW_ANY_HOST ? 'any host (CSAT_ALLOW_ANY_HOST=1)' : [...ALLOWED_HOSTS].join(', ')}\n`,
  );
});

/* ------------------------------------------------------------------ */

function publicConfig() {
  return {
    defaults: DEFAULT_CONFIG,
    relay: { available: true, allowAnyHost: ALLOW_ANY_HOST, allowedHosts: [...ALLOWED_HOSTS] },
  };
}

async function handleSubmit(req, res) {
  let payload;
  try {
    payload = JSON.parse(await readBody(req, 1_000_000));
  } catch {
    return sendJson(res, 400, { error: 'Request body must be JSON.' });
  }

  const { url, method = 'POST', headers = {}, body = null, timeoutMs = 10000 } = payload || {};
  if (typeof url !== 'string' || url === '') return sendJson(res, 400, { error: 'A "url" is required.' });

  let target;
  try {
    target = new URL(url);
  } catch {
    return sendJson(res, 400, { error: `Not a valid URL: ${url}` });
  }
  if (!/^https?:$/.test(target.protocol)) {
    return sendJson(res, 400, { error: 'Only http and https targets are allowed.' });
  }
  if (!ALLOW_ANY_HOST && !ALLOWED_HOSTS.has(target.hostname.toLowerCase())) {
    return sendJson(res, 403, {
      error: `Relaying to "${target.hostname}" is not allowed. Add it with CSAT_ALLOWED_HOSTS=${target.hostname} `
        + 'or set CSAT_ALLOW_ANY_HOST=1.',
    });
  }

  const startedAt = Date.now();
  try {
    const response = await transport({
      url: target.toString(),
      method: String(method).toUpperCase(),
      headers: sanitizeHeaders(headers),
      body,
      timeoutMs: Number(timeoutMs) || 0,
    });
    return sendJson(res, 200, { ...response, durationMs: Date.now() - startedAt });
  } catch (error) {
    return sendJson(res, 200, {
      status: 0,
      statusText: '',
      ok: false,
      body: '',
      error: error.cause?.code ? `${error.message} (${error.cause.code})` : error.message,
      durationMs: Date.now() - startedAt,
    });
  }
}

/** Drops hop-by-hop headers so the relayed request stays well-formed. */
function sanitizeHeaders(headers) {
  const blocked = new Set(['host', 'connection', 'content-length', 'transfer-encoding', 'upgrade', 'keep-alive']);
  const out = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!blocked.has(key.toLowerCase()) && value != null) out[key] = String(value);
  }
  return out;
}

async function serveStatic(pathname, res) {
  const rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname).replace(/^\/+/, '');

  // /src/* comes from src/, everything else from public/.
  const [base, relative] = rel.startsWith('src/')
    ? [SRC_DIR, rel.slice(4)]
    : [PUBLIC_DIR, rel];

  const filePath = path.resolve(base, relative);
  if (filePath !== base && !filePath.startsWith(base + path.sep)) {
    return sendJson(res, 403, { error: 'Forbidden' });
  }

  try {
    const data = await fs.readFile(filePath);
    res.writeHead(200, {
      'content-type': MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream',
      'cache-control': 'no-cache',
    });
    res.end(data);
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function sendJson(res, status, payload) {
  const data = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) });
  res.end(data);
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith('--')) continue;
    const [key, inline] = arg.slice(2).split('=');
    out[key] = inline !== undefined ? inline : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true');
  }
  return out;
}
