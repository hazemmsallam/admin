/**
 * JavaScript port of csat.py — submits a fixed set of survey answers to the
 * CSAT endpoint for every MSISDN in a list.
 *
 * The module is transport-agnostic: callers pass a `transport` function that
 * performs one HTTP request. The browser uses either a direct `fetch` or a
 * hop through the bundled proxy (to sidestep CORS); the CLI uses `fetch`
 * straight from Node. See createFetchTransport below.
 */

export const DEFAULT_CONFIG = {
  baseUrl: 'http://prod-csat.myorange.jt.jtgroup/csat/v1/submitAnswers',
  surveyId: 91,
  channelId: 7,

  /** 'GET' or 'POST'. The original script used GET; POST is the default here. */
  method: 'POST',
  /** 'query' keeps the parameters in the query string; 'json' sends a JSON body. */
  paramStyle: 'query',

  timeoutMs: 10000,
  /** Pause between individual requests, per worker. */
  delayMs: 0,
  /** MSISDNs processed in parallel. 1 matches the original sequential script. */
  concurrency: 1,

  // (question_id, answer_id) — `answer` defaults to answer_id, as in csat.py.
  questions: [
    { questionId: 335, answerId: 3019, answer: 3019 },
    { questionId: 336, answerId: -1, answer: -1 },
    { questionId: 337, answerId: 3029, answer: 3029 },
    { questionId: 338, answerId: 3030, answer: 3030 },
    { questionId: 339, answerId: 3041, answer: 3041 },
  ],

  headers: { accept: 'application/json' },
};

/** Deep-ish copy so callers can mutate a config without touching the default. */
export function cloneConfig(config = DEFAULT_CONFIG) {
  return {
    ...DEFAULT_CONFIG,
    ...config,
    questions: (config.questions || DEFAULT_CONFIG.questions).map((q) => ({ ...q })),
    headers: { ...DEFAULT_CONFIG.headers, ...(config.headers || {}) },
  };
}

/* ------------------------------------------------------------------ *
 * MSISDN handling
 * ------------------------------------------------------------------ */

/** Strips spacing and separators; keeps a single leading +. */
export function normalizeMsisdn(value) {
  const text = String(value ?? '').trim();
  if (text === '') return '';
  const plus = text.startsWith('+') ? '+' : '';
  return plus + text.replace(/[^\d]/g, '');
}

export function isValidMsisdn(value) {
  return /^\+?\d{6,15}$/.test(normalizeMsisdn(value));
}

/**
 * Turns a column of raw cell values into a clean MSISDN list.
 * @returns {{valid: string[], invalid: Array<{value: string, row: number}>, duplicates: number}}
 */
export function collectMsisdns(values, { dedupe = true } = {}) {
  const valid = [];
  const invalid = [];
  const seen = new Set();
  let duplicates = 0;

  values.forEach((raw, index) => {
    // Only a genuinely blank cell is ignored; anything else that fails to
    // normalize is reported, so nothing disappears without the operator seeing it.
    const text = String(raw ?? '').trim();
    if (text === '') return;

    const normalized = normalizeMsisdn(text);
    if (!isValidMsisdn(normalized)) {
      invalid.push({ value: text, row: index + 1 });
      return;
    }
    if (dedupe && seen.has(normalized)) {
      duplicates += 1;
      return;
    }
    seen.add(normalized);
    valid.push(normalized);
  });

  return { valid, invalid, duplicates };
}

/* ------------------------------------------------------------------ *
 * Request building
 * ------------------------------------------------------------------ */

/** The exact parameter set csat.py sent. */
export function buildParams(msisdn, question, config) {
  return {
    question_id: question.questionId,
    answer_id: question.answerId,
    answer: question.answer ?? question.answerId,
    survey_id: config.surveyId,
    channel_id: config.channelId,
    msisdn,
  };
}

export function buildRequest(msisdn, question, config) {
  const params = buildParams(msisdn, question, config);
  const method = (config.method || 'POST').toUpperCase();
  const asJsonBody = method !== 'GET' && config.paramStyle === 'json';

  const url = new URL(config.baseUrl);
  if (!asJsonBody) {
    for (const [key, value] of Object.entries(params)) {
      url.searchParams.set(key, String(value));
    }
  }

  const headers = { ...config.headers };
  let body = null;
  if (asJsonBody) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(params);
  }

  return { url: url.toString(), method, headers, body, params };
}

/* ------------------------------------------------------------------ *
 * Transports
 * ------------------------------------------------------------------ */

/**
 * Issues the request with the platform `fetch`.
 * Works unchanged in Node 18+ and in the browser (subject to CORS there).
 */
export function createFetchTransport(fetchImpl = globalThis.fetch) {
  return async function fetchTransport({ url, method, headers, body, timeoutMs, signal }) {
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(new Error('timeout')), timeoutMs) : null;
    const onAbort = () => controller.abort(signal.reason);
    if (signal) {
      if (signal.aborted) controller.abort(signal.reason);
      else signal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      const response = await fetchImpl(url, { method, headers, body, signal: controller.signal });
      const text = await response.text();
      return {
        status: response.status,
        statusText: response.statusText,
        ok: response.ok,
        body: text,
      };
    } finally {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  };
}

/* ------------------------------------------------------------------ *
 * Submission
 * ------------------------------------------------------------------ */

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Submits one (msisdn, question) pair. Never throws — failures come back on the result. */
export async function submitAnswer(msisdn, question, config, { transport, signal } = {}) {
  const request = buildRequest(msisdn, question, config);
  const startedAt = Date.now();

  try {
    const response = await transport({ ...request, timeoutMs: config.timeoutMs, signal });
    return {
      msisdn,
      questionId: question.questionId,
      answerId: question.answerId,
      answer: request.params.answer,
      url: request.url,
      method: request.method,
      status: response.status,
      statusText: response.statusText || '',
      ok: response.ok ?? (response.status >= 200 && response.status < 300),
      body: response.body ?? '',
      error: null,
      durationMs: Date.now() - startedAt,
      startedAt,
    };
  } catch (error) {
    return {
      msisdn,
      questionId: question.questionId,
      answerId: question.answerId,
      answer: request.params.answer,
      url: request.url,
      method: request.method,
      status: 0,
      statusText: '',
      ok: false,
      body: '',
      error: describeError(error),
      durationMs: Date.now() - startedAt,
      startedAt,
    };
  }
}

function describeError(error) {
  if (!error) return 'Unknown error';
  const name = error.name || '';
  const message = error.message || String(error);
  if (name === 'AbortError' || /abort/i.test(message)) {
    return /timeout/i.test(message) || /timeout/i.test(String(error.cause?.message || '')) ? 'Request timed out' : 'Cancelled';
  }
  if (name === 'TimeoutError') return 'Request timed out';
  const cause = error.cause?.message || error.cause?.code;
  return cause ? `${message} (${cause})` : message;
}

/** Runs every question for a single MSISDN, in order. */
export async function processMsisdn(msisdn, config, { transport, signal, onResult } = {}) {
  const results = [];
  for (const question of config.questions) {
    if (signal?.aborted) break;
    const result = await submitAnswer(msisdn, question, config, { transport, signal });
    results.push(result);
    onResult?.(result);
    if (config.delayMs > 0 && !signal?.aborted) await sleep(config.delayMs);
  }
  return results;
}

/**
 * Runs the whole list. Mirrors csat.py's loop, with optional parallelism across
 * MSISDNs; the questions for one MSISDN always run sequentially.
 *
 * @returns {Promise<{results: object[], summary: object}>}
 */
export async function processAll(msisdns, config, hooks = {}) {
  const { transport, signal, onResult, onMsisdnStart, onMsisdnDone, onDone } = hooks;
  const results = [];
  const workers = Math.max(1, Math.min(Number(config.concurrency) || 1, 20));
  const startedAt = Date.now();

  let cursor = 0;
  const runWorker = async () => {
    while (!signal?.aborted) {
      const index = cursor;
      cursor += 1;
      if (index >= msisdns.length) return;

      const msisdn = msisdns[index];
      onMsisdnStart?.(msisdn, index);
      const perMsisdn = await processMsisdn(msisdn, config, {
        transport,
        signal,
        onResult: (result) => { results.push(result); onResult?.(result); },
      });
      onMsisdnDone?.(msisdn, index, perMsisdn);
    }
  };

  await Promise.all(Array.from({ length: workers }, runWorker));

  const summary = {
    msisdns: msisdns.length,
    requests: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    durationMs: Date.now() - startedAt,
    cancelled: Boolean(signal?.aborted),
  };
  onDone?.(summary, results);
  return { results, summary };
}

/* ------------------------------------------------------------------ *
 * Formatting — same shape as the print() calls in csat.py
 * ------------------------------------------------------------------ */

export function formatResultLine(result) {
  if (result.error) return `Failed for Q:${result.questionId}: ${result.error}`;
  return `Q:${result.questionId} A:${result.answerId} Status=${result.status} Response=${result.body}`;
}

export function resultsToCsv(results) {
  const header = ['msisdn', 'question_id', 'answer_id', 'answer', 'method', 'status', 'ok', 'duration_ms', 'response', 'error'];
  const escape = (value) => {
    const text = String(value ?? '');
    return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const lines = [header.join(',')];
  for (const r of results) {
    lines.push([
      r.msisdn, r.questionId, r.answerId, r.answer, r.method,
      r.status, r.ok, r.durationMs, r.body, r.error || '',
    ].map(escape).join(','));
  }
  return lines.join('\n');
}
