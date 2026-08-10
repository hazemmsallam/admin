#!/usr/bin/env node
/**
 * Command-line equivalent of csat.py.
 *
 *   node src/cli.js --input msisdns.xlsx
 *   node src/cli.js --input list.csv --column MSISDN --method GET
 *   node src/cli.js 962791234567 962791234568 --dry-run
 *
 * Output mirrors the original script:
 *   Processing 962791234567
 *   Q:335 A:3019 Status=200 Response={"ok":true}
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import {
  DEFAULT_CONFIG, cloneConfig, collectMsisdns, createFetchTransport,
  buildRequest, processAll, formatResultLine, resultsToCsv,
} from './csat.js';
import {
  readWorkbook, inflateRawNode, parseDelimited, isDelimitedFile, columnLetterToIndex,
} from './xlsx-lite.js';

const USAGE = `
Submit CSAT survey answers for a list of MSISDNs.

Usage:
  node src/cli.js [options] [msisdn ...]

Input:
  --input <file>        .xlsx / .xlsm / .csv / .tsv / .txt containing the MSISDNs
  --sheet <name|index>  worksheet to read (default: first)
  --column <name|letter|index>
                        column holding the MSISDNs (default: auto-detect)
  --no-dedupe           keep repeated MSISDNs

Request:
  --base-url <url>      default: ${DEFAULT_CONFIG.baseUrl}
  --survey <id>         default: ${DEFAULT_CONFIG.surveyId}
  --channel <id>        default: ${DEFAULT_CONFIG.channelId}
  --method <GET|POST>   default: ${DEFAULT_CONFIG.method}
  --json-body           send parameters as a JSON body instead of query string
  --questions <list>    "335:3019,336:-1" — question_id:answer_id pairs
                        (optional third part sets "answer": "335:3019:1")
  --timeout <ms>        default: ${DEFAULT_CONFIG.timeoutMs}
  --delay <ms>          pause between requests (default: 0)
  --concurrency <n>     MSISDNs in parallel (default: 1)

Output:
  --out <file>          write results to .json or .csv
  --dry-run             print the requests without sending them
  -h, --help
`.trim();

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exit(1);
});

async function main() {
  const { flags, positionals } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }

  const config = cloneConfig({
    baseUrl: flags['base-url'] || DEFAULT_CONFIG.baseUrl,
    surveyId: num(flags.survey, DEFAULT_CONFIG.surveyId),
    channelId: num(flags.channel, DEFAULT_CONFIG.channelId),
    method: (flags.method || DEFAULT_CONFIG.method).toUpperCase(),
    paramStyle: flags['json-body'] ? 'json' : 'query',
    timeoutMs: num(flags.timeout, DEFAULT_CONFIG.timeoutMs),
    delayMs: num(flags.delay, 0),
    concurrency: num(flags.concurrency, 1),
    questions: flags.questions ? parseQuestions(flags.questions) : DEFAULT_CONFIG.questions,
  });

  const raw = flags.input
    ? await readMsisdnColumn(flags.input, flags)
    : positionals;

  const { valid, invalid, duplicates } = collectMsisdns(raw, { dedupe: !flags['no-dedupe'] });

  if (invalid.length > 0) {
    process.stderr.write(`Skipped ${invalid.length} value(s) that are not MSISDNs, e.g. "${invalid[0].value}"\n`);
  }
  if (duplicates > 0) process.stderr.write(`Skipped ${duplicates} duplicate(s)\n`);
  if (valid.length === 0) throw new Error('No MSISDNs to process. Pass --input <file> or list them as arguments.');

  if (flags['dry-run']) {
    for (const msisdn of valid) {
      process.stdout.write(`\nProcessing ${msisdn}\n`);
      for (const question of config.questions) {
        const request = buildRequest(msisdn, question, config);
        process.stdout.write(`${request.method} ${request.url}${request.body ? ` body=${request.body}` : ''}\n`);
      }
    }
    process.stdout.write(`\nDry run: ${valid.length * config.questions.length} request(s) not sent.\n`);
    return;
  }

  const transport = createFetchTransport();
  const { results, summary } = await processAll(valid, config, {
    transport,
    onMsisdnStart: (msisdn) => process.stdout.write(`\nProcessing ${msisdn}\n`),
    onResult: (result) => process.stdout.write(`${formatResultLine(result)}\n`),
  });

  process.stdout.write(
    `\n${summary.requests} request(s) for ${summary.msisdns} MSISDN(s): `
    + `${summary.succeeded} ok, ${summary.failed} failed, ${(summary.durationMs / 1000).toFixed(1)}s\n`,
  );

  if (flags.out) {
    const target = path.resolve(flags.out);
    const data = target.toLowerCase().endsWith('.csv')
      ? resultsToCsv(results)
      : JSON.stringify({ summary, results }, null, 2);
    await fs.writeFile(target, data, 'utf8');
    process.stdout.write(`Results written to ${target}\n`);
  }

  if (summary.failed > 0) process.exitCode = 1;
}

/* ------------------------------------------------------------------ */

async function readMsisdnColumn(file, flags) {
  const buffer = await fs.readFile(path.resolve(file));

  const rows = isDelimitedFile(file)
    ? parseDelimited(buffer.toString('utf8'))
    : pickSheet(await readWorkbook(toArrayBuffer(buffer), { inflateRaw: inflateRawNode }), flags.sheet).rows;

  if (rows.length === 0) throw new Error(`${file} has no rows.`);
  return extractColumn(rows, flags.column);
}

function pickSheet(workbook, selector) {
  if (selector === undefined) return workbook.sheets[0];
  const byIndex = Number(selector);
  if (Number.isInteger(byIndex) && workbook.sheets[byIndex]) return workbook.sheets[byIndex];
  const found = workbook.sheets.find((s) => s.name.toLowerCase() === String(selector).toLowerCase());
  if (!found) throw new Error(`No worksheet named "${selector}". Available: ${workbook.sheets.map((s) => s.name).join(', ')}`);
  return found;
}

/** Picks the requested column, or the one holding the most phone-like values. */
function extractColumn(rows, selector) {
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  let index;

  if (selector !== undefined) {
    const header = rows[0] || [];
    const byHeader = header.findIndex((cell) => cell.trim().toLowerCase() === String(selector).trim().toLowerCase());
    if (byHeader >= 0) index = byHeader;
    else if (/^\d+$/.test(String(selector))) index = Number(selector);
    else if (/^[A-Za-z]+$/.test(String(selector))) index = columnLetterToIndex(String(selector).toUpperCase());
    else throw new Error(`Cannot find column "${selector}".`);
  } else {
    let best = { index: 0, score: -1 };
    for (let col = 0; col < width; col += 1) {
      const score = rows.reduce((n, row) => n + (/^\+?[\d\s()+.-]{6,20}$/.test(String(row[col] ?? '').trim()) ? 1 : 0), 0);
      if (score > best.score) best = { index: col, score };
    }
    index = best.index;
  }

  const values = rows.map((row) => row[index] ?? '');
  // Drop a header row such as "MSISDN" / "Phone".
  if (values.length > 1 && values[0] && !/^\+?[\d\s()+.-]+$/.test(values[0].trim())) values.shift();
  return values;
}

function parseQuestions(text) {
  return String(text).split(',').map((pair) => {
    const [q, a, answer] = pair.split(':').map((part) => part.trim());
    if (q === '' || a === undefined) throw new Error(`Bad --questions entry "${pair}". Use question_id:answer_id.`);
    return { questionId: Number(q), answerId: Number(a), answer: answer !== undefined ? Number(answer) : Number(a) };
  });
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function num(value, fallback) {
  const parsed = Number(value);
  return value === undefined || Number.isNaN(parsed) ? fallback : parsed;
}

function parseArgs(argv) {
  const flags = {};
  const positionals = [];
  const valueless = new Set(['dry-run', 'json-body', 'no-dedupe', 'help', 'h']);

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '-h') { flags.help = true; continue; }
    if (!arg.startsWith('--')) { positionals.push(arg); continue; }

    const [key, inline] = arg.slice(2).split('=');
    if (inline !== undefined) flags[key] = inline;
    else if (valueless.has(key)) flags[key] = true;
    else flags[key] = argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
  }
  return { flags, positionals };
}
