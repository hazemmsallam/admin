/**
 * Browser controller for the CSAT MSISDN tool.
 *
 * Reads MSISDNs out of a spreadsheet locally, lets the operator confirm the
 * request settings, then replays csat.py's submission loop from the page and
 * writes every response back into the table and log.
 */

import {
  DEFAULT_CONFIG, cloneConfig, collectMsisdns, processAll,
  createFetchTransport, formatResultLine, resultsToCsv,
} from '../src/csat.js';
import {
  readWorkbook, parseDelimited, isDelimitedFile, indexToColumnLetter,
} from '../src/xlsx-lite.js';

const MAX_TABLE_ROWS = 1000;
const MAX_LOG_LINES = 4000;

const $ = (id) => document.getElementById(id);

const state = {
  config: cloneConfig(DEFAULT_CONFIG),
  relayAvailable: false,
  fileName: '',
  sheets: [],           // [{name, rows}]
  sheetIndex: 0,
  columnIndex: 0,
  headerSkipped: false,
  msisdns: [],
  results: [],
  logLines: [],
  running: false,
  abort: null,
  startedAt: 0,
  timer: null,
  renderedRows: 0,
};

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

init();

async function init() {
  bindSource();
  bindSettings();
  bindRun();
  bindResults();
  renderQuestions();
  writeConfigToForm();
  await loadServerConfig();
}

async function loadServerConfig() {
  const badge = $('relay-badge');
  try {
    const response = await fetch('./api/config');
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    state.relayAvailable = Boolean(data.relay?.available);
    state.config = cloneConfig(data.defaults || DEFAULT_CONFIG);
    writeConfigToForm();
    badge.textContent = data.relay?.allowAnyHost
      ? 'relay: any host'
      : `relay: ${(data.relay?.allowedHosts || []).join(', ')}`;
  } catch {
    state.relayAvailable = false;
    $('cfg-mode').value = 'direct';
    badge.textContent = 'relay unavailable — sending directly';
    showAlert(
      'warn',
      'The local relay is not reachable, so requests go straight from the browser. '
      + 'That usually fails on CORS — start the tool with "node server.js" and open it from there.',
    );
  }
}

/* ------------------------------------------------------------------ *
 * Step 1 — source
 * ------------------------------------------------------------------ */

function bindSource() {
  const dropzone = $('dropzone');
  const input = $('file-input');

  dropzone.addEventListener('click', () => input.click());
  dropzone.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); }
  });
  input.addEventListener('change', () => { if (input.files[0]) loadFile(input.files[0]); });

  ['dragenter', 'dragover'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((type) => dropzone.addEventListener(type, (event) => {
    event.preventDefault();
    dropzone.classList.remove('is-over');
  }));
  dropzone.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });

  $('btn-sample').addEventListener('click', () => {
    const area = $('paste-area');
    area.classList.toggle('hidden');
    $('btn-sample').textContent = area.classList.contains('hidden') ? 'Paste instead' : 'Hide paste box';
    if (!area.classList.contains('hidden')) $('paste-input').focus();
  });

  $('btn-use-paste').addEventListener('click', () => {
    const lines = $('paste-input').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length === 0) { showAlert('bad', 'The paste box is empty.'); return; }
    state.fileName = 'pasted list';
    state.sheets = [{ name: 'Pasted', rows: lines.map((line) => [line]) }];
    state.sheetIndex = 0;
    applySheet();
  });

  $('select-sheet').addEventListener('change', (event) => {
    state.sheetIndex = Number(event.target.value);
    applySheet();
  });
  $('select-column').addEventListener('change', (event) => {
    state.columnIndex = Number(event.target.value);
    refreshMsisdns();
  });
  $('chk-dedupe').addEventListener('change', refreshMsisdns);
}

async function loadFile(file) {
  clearAlert();
  try {
    state.fileName = file.name;

    if (isDelimitedFile(file.name)) {
      state.sheets = [{ name: file.name, rows: parseDelimited(await file.text()) }];
    } else {
      const workbook = await readWorkbook(await file.arrayBuffer(), { inflateRaw: inflateRawBrowser });
      state.sheets = workbook.sheets;
    }

    if (state.sheets.every((sheet) => sheet.rows.length === 0)) {
      throw new Error('That file has no rows.');
    }
    state.sheetIndex = state.sheets.findIndex((sheet) => sheet.rows.length > 0);
    applySheet();
  } catch (error) {
    showAlert('bad', `Could not read ${file.name}: ${error.message}`);
  }
}

/** Raw DEFLATE via the platform decompressor — no third-party library needed. */
async function inflateRawBrowser(bytes) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot decompress .xlsx files. Save the sheet as .csv and try again.');
  }
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function applySheet() {
  const sheetSelect = $('select-sheet');
  sheetSelect.innerHTML = '';
  state.sheets.forEach((sheet, index) => {
    sheetSelect.append(new Option(`${sheet.name} (${sheet.rows.length} rows)`, String(index)));
  });
  sheetSelect.value = String(state.sheetIndex);
  $('chip-sheet-wrap').classList.toggle('hidden', state.sheets.length < 2);

  const rows = currentRows();
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);

  const columnSelect = $('select-column');
  columnSelect.innerHTML = '';
  let best = { index: 0, score: -1 };
  for (let col = 0; col < Math.max(width, 1); col += 1) {
    const score = rows.reduce((n, row) => n + (looksLikeMsisdn(row[col]) ? 1 : 0), 0);
    const header = String(rows[0]?.[col] ?? '').trim();
    const label = header && !looksLikeMsisdn(header)
      ? `${indexToColumnLetter(col)} — ${header}`
      : `Column ${indexToColumnLetter(col)}`;
    columnSelect.append(new Option(`${label} (${score} match${score === 1 ? '' : 'es'})`, String(col)));
    if (score > best.score) best = { index: col, score };
  }

  state.columnIndex = best.index;
  columnSelect.value = String(best.index);

  $('chip-file').textContent = state.fileName;
  $('source-detail').classList.remove('hidden');
  refreshMsisdns();
}

const currentRows = () => state.sheets[state.sheetIndex]?.rows || [];

function looksLikeMsisdn(value) {
  const text = String(value ?? '').trim();
  return text !== '' && /^\+?[\d\s()+.-]{6,20}$/.test(text) && (text.match(/\d/g) || []).length >= 6;
}

function refreshMsisdns() {
  const values = currentRows().map((row) => row[state.columnIndex] ?? '');

  // Drop a header cell such as "MSISDN" or "Phone number".
  state.headerSkipped = values.length > 1 && String(values[0]).trim() !== '' && !looksLikeMsisdn(values[0]);
  const body = state.headerSkipped ? values.slice(1) : values;

  const { valid, invalid, duplicates } = collectMsisdns(body, { dedupe: $('chk-dedupe').checked });
  state.msisdns = valid;

  const summary = $('summary-row');
  summary.innerHTML = '';
  summary.append(pill('ok', `${valid.length} MSISDN${valid.length === 1 ? '' : 's'} ready`));
  if (duplicates > 0) summary.append(pill('warn', `${duplicates} duplicate${duplicates === 1 ? '' : 's'} removed`));
  if (invalid.length > 0) {
    summary.append(pill('bad', `${invalid.length} skipped — e.g. "${truncate(invalid[0].value, 24)}"`));
  }
  if (state.headerSkipped) summary.append(pill('warn', 'header row skipped'));

  const list = $('preview-list');
  list.innerHTML = '';
  valid.slice(0, 200).forEach((msisdn) => {
    const item = document.createElement('li');
    item.textContent = msisdn;
    list.append(item);
  });
  if (valid.length > 200) {
    const item = document.createElement('li');
    item.textContent = `… ${valid.length - 200} more`;
    item.style.color = 'var(--muted)';
    list.append(item);
  }

  updatePlan();
}

function pill(kind, text) {
  const span = document.createElement('span');
  span.className = `pill pill-${kind}`;
  span.textContent = text;
  return span;
}

/* ------------------------------------------------------------------ *
 * Step 2 — settings
 * ------------------------------------------------------------------ */

function bindSettings() {
  const bindings = [
    ['cfg-base-url', 'baseUrl', String],
    ['cfg-survey', 'surveyId', Number],
    ['cfg-channel', 'channelId', Number],
    ['cfg-timeout', 'timeoutMs', Number],
    ['cfg-delay', 'delayMs', Number],
    ['cfg-concurrency', 'concurrency', Number],
  ];
  for (const [id, key, cast] of bindings) {
    $(id).addEventListener('input', (event) => {
      state.config[key] = cast(event.target.value);
      updatePlan();
    });
  }

  $('cfg-method').addEventListener('change', (event) => {
    const [method, paramStyle] = event.target.value.split('|');
    state.config.method = method;
    state.config.paramStyle = paramStyle;
  });

  $('cfg-mode').addEventListener('change', (event) => {
    if (event.target.value === 'relay' && !state.relayAvailable) {
      showAlert('warn', 'The relay is not reachable from this page; start the tool with "node server.js".');
    } else {
      clearAlert();
    }
  });

  $('btn-add-question').addEventListener('click', () => {
    state.config.questions.push({ questionId: 0, answerId: 0, answer: 0 });
    renderQuestions();
    updatePlan();
  });

  $('btn-reset').addEventListener('click', () => {
    state.config = cloneConfig(DEFAULT_CONFIG);
    writeConfigToForm();
    renderQuestions();
    updatePlan();
    clearAlert();
  });
}

function writeConfigToForm() {
  $('cfg-base-url').value = state.config.baseUrl;
  $('cfg-survey').value = state.config.surveyId;
  $('cfg-channel').value = state.config.channelId;
  $('cfg-timeout').value = state.config.timeoutMs;
  $('cfg-delay').value = state.config.delayMs;
  $('cfg-concurrency').value = state.config.concurrency;
  $('cfg-method').value = `${state.config.method}|${state.config.paramStyle}`;
  $('cfg-mode').value = state.relayAvailable ? 'relay' : 'direct';
}

function renderQuestions() {
  const body = $('questions-body');
  body.innerHTML = '';

  state.config.questions.forEach((question, index) => {
    const row = document.createElement('tr');

    for (const key of ['questionId', 'answerId', 'answer']) {
      const cell = document.createElement('td');
      const input = document.createElement('input');
      input.type = 'number';
      input.value = question[key] ?? question.answerId;
      input.addEventListener('input', () => {
        const value = Number(input.value);
        question[key] = value;
        // `answer` tracks `answer_id` until it is edited on its own, as in csat.py.
        if (key === 'answerId' && !question.answerEdited) {
          question.answer = value;
          row.querySelector('[data-answer]').value = value;
        }
        if (key === 'answer') question.answerEdited = true;
        updatePlan();
      });
      if (key === 'answer') input.dataset.answer = 'true';
      cell.append(input);
      row.append(cell);
    }

    const actions = document.createElement('td');
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'btn btn-icon';
    remove.title = 'Remove question';
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      state.config.questions.splice(index, 1);
      renderQuestions();
      updatePlan();
    });
    actions.append(remove);
    row.append(actions);

    body.append(row);
  });
}

/* ------------------------------------------------------------------ *
 * Step 3 — run
 * ------------------------------------------------------------------ */

function bindRun() {
  $('btn-start').addEventListener('click', start);
  $('btn-stop').addEventListener('click', () => {
    state.abort?.abort(new DOMException('Stopped by operator', 'AbortError'));
    $('btn-stop').disabled = true;
  });
  $('btn-clear').addEventListener('click', clearResults);
}

function updatePlan() {
  const requests = state.msisdns.length * state.config.questions.length;
  $('plan-note').textContent = state.msisdns.length === 0
    ? 'Load a list to begin.'
    : `${state.msisdns.length} MSISDN × ${state.config.questions.length} question`
      + `${state.config.questions.length === 1 ? '' : 's'} = ${requests} request${requests === 1 ? '' : 's'}`;
  $('btn-start').disabled = state.running || requests === 0;
}

async function start() {
  if (state.running || state.msisdns.length === 0) return;

  clearResults();
  clearAlert();

  state.running = true;
  state.abort = new AbortController();
  state.startedAt = Date.now();

  const total = state.msisdns.length * state.config.questions.length;
  $('btn-start').classList.add('hidden');
  $('btn-stop').classList.remove('hidden');
  $('btn-stop').disabled = false;
  $('btn-clear').disabled = true;
  $('progress-wrap').classList.remove('hidden');
  $('stat-grid').classList.remove('hidden');
  $('results-card').classList.remove('hidden');
  state.timer = setInterval(updateElapsed, 200);

  const useRelay = $('cfg-mode').value === 'relay';
  const transport = useRelay ? relayTransport : createFetchTransport();

  try {
    const { summary } = await processAll(state.msisdns, state.config, {
      transport,
      signal: state.abort.signal,
      onMsisdnStart: (msisdn) => appendLog(`\nProcessing ${msisdn}`),
      onResult: (result) => {
        state.results.push(result);
        appendLog(formatResultLine(result));
        appendResultRow(result);
        updateStats(total);
      },
    });

    const seconds = (summary.durationMs / 1000).toFixed(1);
    if (summary.cancelled) {
      showAlert('warn', `Stopped after ${summary.requests} of ${total} requests — ${summary.succeeded} ok, ${summary.failed} failed.`);
    } else if (summary.failed === 0) {
      showAlert('ok', `Done — ${summary.requests} requests for ${summary.msisdns} MSISDNs in ${seconds}s, all successful.`);
    } else {
      showAlert('bad', `Done — ${summary.succeeded} of ${summary.requests} requests succeeded, ${summary.failed} failed in ${seconds}s.`);
    }
  } catch (error) {
    showAlert('bad', `Run stopped: ${error.message}`);
  } finally {
    state.running = false;
    clearInterval(state.timer);
    updateElapsed();
    updateStats(total);
    $('btn-start').classList.remove('hidden');
    $('btn-stop').classList.add('hidden');
    $('btn-clear').disabled = false;
    updatePlan();
  }
}

/** Sends the request through the local server, which is not bound by CORS. */
async function relayTransport({ url, method, headers, body, timeoutMs, signal }) {
  const response = await fetch('./api/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url, method, headers, body, timeoutMs }),
    signal,
  });

  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.error || `Relay returned ${response.status}`);
  }

  const result = await response.json();
  if (result.error) throw new Error(result.error);
  return result;
}

function updateStats(total) {
  const ok = state.results.filter((r) => r.ok).length;
  $('stat-total').textContent = String(state.results.length);
  $('stat-ok').textContent = String(ok);
  $('stat-failed').textContent = String(state.results.length - ok);

  const percent = total === 0 ? 0 : Math.round((state.results.length / total) * 100);
  $('progress-fill').style.width = `${percent}%`;
  $('progress-label').textContent = `${state.results.length} / ${total} (${percent}%)`;
}

function updateElapsed() {
  $('stat-elapsed').textContent = `${((Date.now() - state.startedAt) / 1000).toFixed(1)}s`;
}

/* ------------------------------------------------------------------ *
 * Results
 * ------------------------------------------------------------------ */

function bindResults() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((other) => other.classList.toggle('is-active', other === tab));
      $('view-table').classList.toggle('hidden', tab.dataset.view !== 'table');
      $('view-log').classList.toggle('hidden', tab.dataset.view !== 'log');
    });
  });

  $('chk-failed-only').addEventListener('change', renderResultsTable);
  $('btn-copy').addEventListener('click', async () => {
    await navigator.clipboard.writeText(state.logLines.join('\n'));
    flash($('btn-copy'), 'Copied');
  });
  $('btn-csv').addEventListener('click', () => {
    download(`csat-results-${stamp()}.csv`, resultsToCsv(state.results), 'text/csv');
  });
  $('btn-json').addEventListener('click', () => {
    download(`csat-results-${stamp()}.json`, JSON.stringify(state.results, null, 2), 'application/json');
  });
}

function appendResultRow(result) {
  if ($('chk-failed-only').checked && result.ok) return;
  if (state.renderedRows >= MAX_TABLE_ROWS) return;
  $('results-body').append(buildRow(result));
  state.renderedRows += 1;
  if (state.renderedRows === MAX_TABLE_ROWS) $('results-body').append(truncationRow());
}

function buildRow(result) {
  const row = document.createElement('tr');
  if (!result.ok) row.className = 'is-failed';

  const cells = [
    ['msisdn', result.msisdn],
    ['', String(result.questionId)],
    ['', String(result.answerId)],
    ['status', null],
    ['', `${result.durationMs} ms`],
    ['response', result.error ? result.error : result.body || '—'],
  ];

  cells.forEach(([className, text], index) => {
    const cell = document.createElement('td');
    if (className) cell.className = className;
    if (index === 3) {
      const badge = document.createElement('span');
      badge.className = `badge ${result.ok ? 'badge-ok' : 'badge-bad'}`;
      badge.textContent = result.status || 'ERR';
      cell.append(badge);
    } else {
      cell.textContent = text;
    }
    if (index === 5) cell.title = result.error || result.body || '';
    row.append(cell);
  });

  return row;
}

function truncationRow() {
  const row = document.createElement('tr');
  const cell = document.createElement('td');
  cell.colSpan = 6;
  cell.className = 'muted';
  cell.textContent = `Showing the first ${MAX_TABLE_ROWS} responses — download the CSV or JSON for the full set.`;
  row.append(cell);
  return row;
}

function renderResultsTable() {
  const body = $('results-body');
  body.innerHTML = '';
  state.renderedRows = 0;
  const failedOnly = $('chk-failed-only').checked;

  for (const result of state.results) {
    if (failedOnly && result.ok) continue;
    if (state.renderedRows >= MAX_TABLE_ROWS) { body.append(truncationRow()); break; }
    body.append(buildRow(result));
    state.renderedRows += 1;
  }
}

function appendLog(line) {
  state.logLines.push(line);
  if (state.logLines.length > MAX_LOG_LINES) state.logLines.shift();

  const view = $('view-log');
  const pinned = view.scrollTop + view.clientHeight >= view.scrollHeight - 24;
  view.textContent = state.logLines.join('\n');
  if (pinned) view.scrollTop = view.scrollHeight;
}

function clearResults() {
  state.results = [];
  state.logLines = [];
  state.renderedRows = 0;
  $('results-body').innerHTML = '';
  $('view-log').textContent = '';
  $('results-card').classList.add('hidden');
  $('progress-wrap').classList.add('hidden');
  $('stat-grid').classList.add('hidden');
  $('progress-fill').style.width = '0';
  $('btn-clear').disabled = true;
  ['stat-total', 'stat-ok', 'stat-failed'].forEach((id) => { $(id).textContent = '0'; });
  $('stat-elapsed').textContent = '0.0s';
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

function showAlert(kind, message) {
  const alert = $('run-alert');
  alert.className = `alert alert-${kind}`;
  alert.textContent = message;
}

function clearAlert() {
  $('run-alert').className = 'alert hidden';
  $('run-alert').textContent = '';
}

function flash(button, text) {
  const original = button.textContent;
  button.textContent = text;
  setTimeout(() => { button.textContent = original; }, 1200);
}

function download(fileName, content, mime) {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(url);
}

const stamp = () => new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const truncate = (text, max) => (text.length > max ? `${text.slice(0, max)}…` : text);
