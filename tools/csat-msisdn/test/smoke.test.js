/**
 * Round-trip tests: a workbook is built in memory with the same ZIP layout
 * Excel produces, then read back through xlsx-lite, plus checks on the
 * request builder, the submission loop and the relay server.
 *
 *   npm test
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { readWorkbook, inflateRawNode, parseDelimited, columnLetterToIndex, indexToColumnLetter } from '../src/xlsx-lite.js';
import { buildRequest, collectMsisdns, normalizeMsisdn, processAll, formatResultLine, resultsToCsv, cloneConfig, DEFAULT_CONFIG } from '../src/csat.js';
import { makeZip, sampleWorkbook, workbookFromMsisdns } from './fixtures.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const toArrayBuffer = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

/* ------------------------------------------------------------------ *
 * xlsx-lite
 * ------------------------------------------------------------------ */

test('reads sheets, shared strings and inline strings out of an xlsx', async () => {
  const { sheets } = await readWorkbook(toArrayBuffer(sampleWorkbook()), { inflateRaw: inflateRawNode });

  assert.equal(sheets.length, 2);
  assert.deepEqual(sheets.map((s) => s.name), ['Subscribers', 'Notes']);

  const rows = sheets[0].rows;
  assert.deepEqual(rows[0], ['MSISDN', 'Owner & agent'], 'entities and rich-text runs are joined');
  assert.deepEqual(rows[1], ['962791234567']);
  assert.deepEqual(rows[3], ['+962 79 123 4569'], 'inline strings are read');
  assert.deepEqual(rows[4], ['', '', '7'], 'gaps are filled from the cell reference');
});

test('long numeric cells keep full precision', async () => {
  const { sheets } = await readWorkbook(toArrayBuffer(sampleWorkbook()), { inflateRaw: inflateRawNode });
  assert.equal(sheets[0].rows[2][0], '962791234568', 'no rounding, no scientific notation');
});

test('rejects files that are not workbooks', async () => {
  await assert.rejects(
    () => readWorkbook(toArrayBuffer(Buffer.from('this is not a zip file at all')), { inflateRaw: inflateRawNode }),
    /end-of-central-directory/,
  );
  await assert.rejects(
    () => readWorkbook(toArrayBuffer(makeZip([{ name: 'a.txt', content: 'hello' }])), { inflateRaw: inflateRawNode }),
    /not an Excel workbook/,
  );
});

test('a header row plus a column of MSISDNs survives the whole read path', async () => {
  const numbers = ['962791234567', '962791234568', '962 79 123 4569'];
  const bytes = workbookFromMsisdns(numbers);
  const { sheets } = await readWorkbook(toArrayBuffer(bytes), { inflateRaw: inflateRawNode });

  const column = sheets[0].rows.map((row) => row[0] ?? '');
  assert.equal(column[0], 'MSISDN', 'the header is present and is dropped by the caller');

  const { valid } = collectMsisdns(column.slice(1));
  assert.deepEqual(valid, ['962791234567', '962791234568', '962791234569']);
});

test('column letters convert both ways', () => {
  assert.equal(columnLetterToIndex('A'), 0);
  assert.equal(columnLetterToIndex('Z'), 25);
  assert.equal(columnLetterToIndex('AA'), 26);
  assert.equal(columnLetterToIndex('BC'), 54);
  assert.equal(indexToColumnLetter(0), 'A');
  assert.equal(indexToColumnLetter(26), 'AA');
  assert.equal(indexToColumnLetter(54), 'BC');
});

test('parses quoted csv and detects the delimiter', () => {
  assert.deepEqual(
    parseDelimited('msisdn,name\r\n962791234567,"Doe, J."\r\n962791234568,"say ""hi"""\r\n'),
    [['msisdn', 'name'], ['962791234567', 'Doe, J.'], ['962791234568', 'say "hi"']],
  );
  assert.deepEqual(parseDelimited('a\tb\n1\t2'), [['a', 'b'], ['1', '2']]);
});

/* ------------------------------------------------------------------ *
 * csat core
 * ------------------------------------------------------------------ */

test('normalizes and validates MSISDNs', () => {
  assert.equal(normalizeMsisdn(' 962-79 123 4567 '), '962791234567');
  assert.equal(normalizeMsisdn('+962 (79) 123.4567'), '+962791234567');
  assert.equal(normalizeMsisdn(962791234567), '962791234567');

  const { valid, invalid, duplicates } = collectMsisdns(
    ['962791234567', '962-791-234-567', '', 'not a number', '962791234568'],
  );
  assert.deepEqual(valid, ['962791234567', '962791234568']);
  assert.equal(duplicates, 1);
  assert.equal(invalid.length, 1);
  assert.equal(invalid[0].value, 'not a number');
});

test('builds the same parameters csat.py sent', () => {
  const config = cloneConfig({ ...DEFAULT_CONFIG, method: 'GET' });
  const request = buildRequest('962791234567', config.questions[0], config);
  const url = new URL(request.url);

  assert.equal(request.method, 'GET');
  assert.equal(request.body, null);
  assert.equal(url.searchParams.get('question_id'), '335');
  assert.equal(url.searchParams.get('answer_id'), '3019');
  assert.equal(url.searchParams.get('answer'), '3019');
  assert.equal(url.searchParams.get('survey_id'), '91');
  assert.equal(url.searchParams.get('channel_id'), '7');
  assert.equal(url.searchParams.get('msisdn'), '962791234567');
});

test('POST keeps parameters in the query string, or moves them into a JSON body', () => {
  const query = buildRequest('962791234567', { questionId: 1, answerId: 2, answer: 2 }, cloneConfig(DEFAULT_CONFIG));
  assert.equal(query.method, 'POST');
  assert.equal(query.body, null);
  assert.ok(query.url.includes('question_id=1'));

  const json = buildRequest(
    '962791234567',
    { questionId: 1, answerId: 2, answer: 1 },
    cloneConfig({ ...DEFAULT_CONFIG, paramStyle: 'json' }),
  );
  assert.equal(json.url.includes('?'), false, 'nothing is appended to the query string');
  assert.deepEqual(JSON.parse(json.body), {
    question_id: 1, answer_id: 2, answer: 1, survey_id: 91, channel_id: 7, msisdn: '962791234567',
  });
  assert.equal(json.headers['content-type'], 'application/json');
});

test('runs every question for every MSISDN and reports a summary', async () => {
  const seen = [];
  const transport = async ({ url }) => {
    seen.push(new URL(url).searchParams.get('msisdn'));
    return { status: 200, statusText: 'OK', ok: true, body: '{"result":"ok"}' };
  };

  const config = cloneConfig(DEFAULT_CONFIG);
  const { results, summary } = await processAll(['962791234567', '962791234568'], config, { transport });

  assert.equal(summary.requests, 10, '2 MSISDNs × 5 questions');
  assert.equal(summary.succeeded, 10);
  assert.equal(summary.failed, 0);
  assert.equal(seen.filter((m) => m === '962791234567').length, 5);
  assert.equal(formatResultLine(results[0]), 'Q:335 A:3019 Status=200 Response={"result":"ok"}');
});

test('a failing request is recorded, not thrown, and the run continues', async () => {
  let calls = 0;
  const transport = async () => {
    calls += 1;
    if (calls === 2) throw new Error('socket hang up');
    return { status: 200, statusText: 'OK', ok: true, body: 'ok' };
  };

  const config = cloneConfig({ ...DEFAULT_CONFIG, questions: DEFAULT_CONFIG.questions.slice(0, 3) });
  const { results, summary } = await processAll(['962791234567'], config, { transport });

  assert.equal(summary.requests, 3, 'the remaining questions still ran');
  assert.equal(summary.failed, 1);
  assert.match(formatResultLine(results[1]), /^Failed for Q:336: socket hang up$/);
});

test('stopping mid-run leaves the remaining requests unsent', async () => {
  const controller = new AbortController();
  const transport = async () => {
    controller.abort();
    return { status: 200, statusText: 'OK', ok: true, body: 'ok' };
  };

  const { summary } = await processAll(['1111111', '2222222'], cloneConfig(DEFAULT_CONFIG), {
    transport,
    signal: controller.signal,
  });
  assert.equal(summary.requests, 1);
  assert.equal(summary.cancelled, true);
});

test('csv export quotes fields containing separators', () => {
  const csv = resultsToCsv([{
    msisdn: '962791234567', questionId: 335, answerId: 3019, answer: 3019, method: 'POST',
    status: 200, ok: true, durationMs: 12, body: '{"a":1,"b":2}', error: null,
  }]);
  const [header, row] = csv.split('\n');
  assert.equal(header, 'msisdn,question_id,answer_id,answer,method,status,ok,duration_ms,response,error');
  assert.ok(row.includes('"{""a"":1,""b"":2}"'));
});

/* ------------------------------------------------------------------ *
 * Relay server
 * ------------------------------------------------------------------ */

test('the relay forwards a request and returns the upstream response', async (t) => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ received: req.url, method: req.method }));
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const upstreamPort = upstream.address().port;

  const port = 8000 + Math.floor(Math.random() * 900);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1' },
    stdio: 'ignore',
  });

  t.after(async () => {
    child.kill();
    await new Promise((resolve) => upstream.close(resolve));
  });

  await waitForServer(`http://127.0.0.1:${port}/api/health`);

  const config = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
  assert.equal(config.defaults.surveyId, 91);
  assert.equal(config.relay.available, true);

  const relayed = await (await fetch(`http://127.0.0.1:${port}/api/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: `http://127.0.0.1:${upstreamPort}/csat?msisdn=962791234567`, method: 'POST' }),
  })).json();

  assert.equal(relayed.status, 200);
  assert.equal(relayed.ok, true);
  assert.deepEqual(JSON.parse(relayed.body), { received: '/csat?msisdn=962791234567', method: 'POST' });

  const blocked = await fetch(`http://127.0.0.1:${port}/api/submit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: 'http://example.com/anything' }),
  });
  assert.equal(blocked.status, 403, 'unknown hosts are refused');

  const page = await fetch(`http://127.0.0.1:${port}/`);
  assert.equal(page.status, 200);
  assert.match(await page.text(), /CSAT Survey Runner/);

  const traversal = await fetch(`http://127.0.0.1:${port}/../server.js`);
  assert.ok(traversal.status === 403 || traversal.status === 404, 'no path traversal out of public/');
});

async function waitForServer(url, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* not up yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Server at ${url} did not start.`);
}
