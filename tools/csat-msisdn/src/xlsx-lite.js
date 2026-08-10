/**
 * Minimal, dependency-free reader for .xlsx / .xlsm workbooks and delimited text.
 *
 * An .xlsx file is a ZIP archive of XML parts. This module walks the ZIP central
 * directory itself and hands the compressed bytes to an `inflateRaw` function
 * supplied by the caller, so the same code runs in both environments:
 *
 *   browser -> DecompressionStream('deflate-raw')   (see public/app.js)
 *   node    -> zlib.inflateRawSync                  (see inflateRawNode below)
 *
 * Cell values are always returned as strings. Numeric cells keep the literal
 * text stored in the file, so a long MSISDN such as 962791234567 survives
 * intact instead of being rounded or turned into 9.62791e+11.
 */

const SIG_LOCAL_HEADER = 0x04034b50;
const SIG_CENTRAL_HEADER = 0x02014b50;
const SIG_EOCD = 0x06054b50;
const SIG_ZIP64_EOCD = 0x06064b50;
const SIG_ZIP64_LOCATOR = 0x07064b50;

const METHOD_STORED = 0;
const METHOD_DEFLATE = 8;

/* ------------------------------------------------------------------ *
 * ZIP container
 * ------------------------------------------------------------------ */

const u16 = (dv, off) => dv.getUint16(off, true);
const u32 = (dv, off) => dv.getUint32(off, true);
const u64 = (dv, off) => dv.getUint32(off + 4, true) * 0x100000000 + dv.getUint32(off, true);

function findEndOfCentralDirectory(dv) {
  const maxScan = Math.min(dv.byteLength, 0xffff + 22);
  for (let back = 22; back <= maxScan; back += 1) {
    const off = dv.byteLength - back;
    if (u32(dv, off) === SIG_EOCD) return off;
  }
  throw new Error('Not a valid .xlsx file (no ZIP end-of-central-directory record).');
}

function readCentralDirectoryBounds(dv) {
  const eocd = findEndOfCentralDirectory(dv);
  let entryCount = u16(dv, eocd + 10);
  let cdOffset = u32(dv, eocd + 16);

  // ZIP64: the 32-bit fields are saturated and the real values live in the
  // ZIP64 record pointed at by the locator that sits just before the EOCD.
  if (entryCount === 0xffff || cdOffset === 0xffffffff) {
    const locator = eocd - 20;
    if (locator >= 0 && u32(dv, locator) === SIG_ZIP64_LOCATOR) {
      const zip64 = u64(dv, locator + 8);
      if (zip64 >= 0 && zip64 + 56 <= dv.byteLength && u32(dv, zip64) === SIG_ZIP64_EOCD) {
        entryCount = u64(dv, zip64 + 32);
        cdOffset = u64(dv, zip64 + 48);
      }
    }
  }
  return { entryCount, cdOffset };
}

/** Pulls the 8-byte ZIP64 overrides out of a central-directory extra field. */
function readZip64Extra(bytes, needSize, needCompressed, needOffset) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let off = 0;
  while (off + 4 <= bytes.byteLength) {
    const id = u16(dv, off);
    const len = u16(dv, off + 2);
    let cur = off + 4;
    if (id === 0x0001) {
      const out = {};
      if (needSize && cur + 8 <= off + 4 + len) { out.size = u64(dv, cur); cur += 8; }
      if (needCompressed && cur + 8 <= off + 4 + len) { out.compressedSize = u64(dv, cur); cur += 8; }
      if (needOffset && cur + 8 <= off + 4 + len) { out.localHeaderOffset = u64(dv, cur); }
      return out;
    }
    off += 4 + len;
  }
  return {};
}

/**
 * Lists the entries in a ZIP archive without decompressing anything.
 * @param {ArrayBuffer} buffer
 * @returns {Map<string, object>} entry name -> descriptor
 */
export function readZipEntries(buffer) {
  const dv = new DataView(buffer);
  const bytes = new Uint8Array(buffer);
  const { entryCount, cdOffset } = readCentralDirectoryBounds(dv);

  const entries = new Map();
  let off = cdOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (off + 46 > dv.byteLength || u32(dv, off) !== SIG_CENTRAL_HEADER) break;

    const method = u16(dv, off + 10);
    let compressedSize = u32(dv, off + 20);
    let size = u32(dv, off + 24);
    const nameLen = u16(dv, off + 28);
    const extraLen = u16(dv, off + 30);
    const commentLen = u16(dv, off + 32);
    let localHeaderOffset = u32(dv, off + 42);

    const name = utf8Decode(bytes.subarray(off + 46, off + 46 + nameLen));

    if (size === 0xffffffff || compressedSize === 0xffffffff || localHeaderOffset === 0xffffffff) {
      const extra = readZip64Extra(
        bytes.subarray(off + 46 + nameLen, off + 46 + nameLen + extraLen),
        size === 0xffffffff,
        compressedSize === 0xffffffff,
        localHeaderOffset === 0xffffffff,
      );
      if (extra.size !== undefined) size = extra.size;
      if (extra.compressedSize !== undefined) compressedSize = extra.compressedSize;
      if (extra.localHeaderOffset !== undefined) localHeaderOffset = extra.localHeaderOffset;
    }

    entries.set(name, { name, method, compressedSize, size, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }

  return entries;
}

/** Returns the raw (still compressed) bytes for one entry. */
function rawEntryBytes(buffer, entry) {
  const dv = new DataView(buffer);
  const start = entry.localHeaderOffset;
  if (start + 30 > dv.byteLength || u32(dv, start) !== SIG_LOCAL_HEADER) {
    throw new Error(`Corrupt archive: bad local header for "${entry.name}".`);
  }
  const dataStart = start + 30 + u16(dv, start + 26) + u16(dv, start + 28);
  return new Uint8Array(buffer, dataStart, entry.compressedSize);
}

async function readEntryText(buffer, entry, inflateRaw) {
  const raw = rawEntryBytes(buffer, entry);
  if (entry.method === METHOD_STORED) return utf8Decode(raw);
  if (entry.method !== METHOD_DEFLATE) {
    throw new Error(`Unsupported ZIP compression method ${entry.method} for "${entry.name}".`);
  }
  return utf8Decode(await inflateRaw(raw));
}

function utf8Decode(bytes) {
  if (typeof TextDecoder !== 'undefined') return new TextDecoder('utf-8').decode(bytes);
  return Buffer.from(bytes).toString('utf8'); // eslint-disable-line no-undef
}

/** Node-side inflate, kept here so the CLI needs no wiring of its own. */
export async function inflateRawNode(bytes) {
  const { inflateRawSync } = await import('node:zlib');
  return new Uint8Array(inflateRawSync(bytes));
}

/* ------------------------------------------------------------------ *
 * Very small XML scanner
 *
 * Only the handful of SpreadsheetML elements below are read, and none of
 * them nest inside themselves, so locating the next matching close tag is
 * enough — no full DOM is required, which keeps this usable under Node too.
 * ------------------------------------------------------------------ */

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(?:#(\d+)|#x([0-9a-fA-F]+)|(amp|lt|gt|quot|apos));/g, (match, dec, hex, named) => {
    if (dec) return String.fromCodePoint(Number(dec));
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    return NAMED_ENTITIES[named] ?? match;
  });
}

function elements(xml, name) {
  const out = [];
  const openRe = new RegExp(`<${name}(?:\\s([^>]*?))?(/?)>`, 'g');
  let match;
  while ((match = openRe.exec(xml)) !== null) {
    const attrs = match[1] || '';
    if (match[2] === '/') {
      out.push({ attrs, inner: '' });
      continue;
    }
    const closeTag = `</${name}>`;
    const end = xml.indexOf(closeTag, openRe.lastIndex);
    if (end === -1) {
      out.push({ attrs, inner: xml.slice(openRe.lastIndex) });
      break;
    }
    out.push({ attrs, inner: xml.slice(openRe.lastIndex, end) });
    openRe.lastIndex = end + closeTag.length;
  }
  return out;
}

function attr(attrs, name) {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*"([^"]*)"`).exec(attrs);
  return match ? decodeEntities(match[1]) : null;
}

/** Concatenates every <t> descendant — handles rich-text runs split across <r>. */
function joinText(inner) {
  return elements(inner, 't').map((t) => decodeEntities(t.inner)).join('');
}

/* ------------------------------------------------------------------ *
 * Workbook
 * ------------------------------------------------------------------ */

/** "BC" -> 54 (zero-based). */
export function columnLetterToIndex(letters) {
  let index = 0;
  for (let i = 0; i < letters.length; i += 1) {
    index = index * 26 + (letters.charCodeAt(i) - 64);
  }
  return index - 1;
}

/** 0 -> "A", 26 -> "AA". */
export function indexToColumnLetter(index) {
  let n = index + 1;
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - rem) / 26);
  }
  return out;
}

function cellValue(cell, sharedStrings) {
  const type = attr(cell.attrs, 't') || 'n';

  if (type === 'inlineStr') return joinText(cell.inner);

  const values = elements(cell.inner, 'v');
  if (values.length === 0) return '';
  const raw = decodeEntities(values[0].inner);

  if (type === 's') {
    const index = Number(raw);
    return sharedStrings[index] ?? '';
  }
  if (type === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  // n / str / d / e: keep the literal text so long numbers stay exact.
  return raw;
}

function parseSheet(xml, sharedStrings) {
  const rows = [];
  for (const row of elements(xml, 'row')) {
    const cells = [];
    let cursor = 0;
    for (const cell of elements(row.inner, 'c')) {
      const ref = attr(cell.attrs, 'r');
      const letters = ref ? /^[A-Z]+/.exec(ref) : null;
      const index = letters ? columnLetterToIndex(letters[0]) : cursor;
      while (cells.length < index) cells.push('');
      cells[index] = cellValue(cell, sharedStrings);
      cursor = index + 1;
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    rows.push(cells);
  }
  while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop();
  return rows;
}

/** Resolves a workbook relationship target such as "worksheets/sheet1.xml". */
function resolveTarget(target) {
  const clean = target.replace(/^\//, '');
  return clean.startsWith('xl/') ? clean : `xl/${clean}`;
}

/**
 * Reads every worksheet in a workbook.
 *
 * @param {ArrayBuffer} buffer raw .xlsx/.xlsm bytes
 * @param {{inflateRaw: (bytes: Uint8Array) => Promise<Uint8Array>|Uint8Array}} options
 * @returns {Promise<{sheets: Array<{name: string, rows: string[][]}>}>}
 */
export async function readWorkbook(buffer, { inflateRaw }) {
  if (typeof inflateRaw !== 'function') {
    throw new Error('readWorkbook requires an inflateRaw implementation.');
  }

  const entries = readZipEntries(buffer);
  const read = async (name) => {
    const entry = entries.get(name);
    return entry ? readEntryText(buffer, entry, inflateRaw) : null;
  };

  const workbookXml = await read('xl/workbook.xml');
  if (!workbookXml) {
    throw new Error('That file is a ZIP but not an Excel workbook (xl/workbook.xml is missing).');
  }

  const relsXml = (await read('xl/_rels/workbook.xml.rels')) || '';
  const relations = new Map();
  for (const rel of elements(relsXml, 'Relationship')) {
    const id = attr(rel.attrs, 'Id');
    const target = attr(rel.attrs, 'Target');
    if (id && target) relations.set(id, resolveTarget(target));
  }

  const sharedXml = await read('xl/sharedStrings.xml');
  const sharedStrings = sharedXml ? elements(sharedXml, 'si').map((si) => joinText(si.inner)) : [];

  const sheets = [];
  const sheetEls = elements(workbookXml, 'sheet');
  for (let i = 0; i < sheetEls.length; i += 1) {
    const sheetEl = sheetEls[i];
    const name = attr(sheetEl.attrs, 'name') || `Sheet${i + 1}`;
    const relId = attr(sheetEl.attrs, 'r:id') || attr(sheetEl.attrs, 'id');
    const path = (relId && relations.get(relId)) || `xl/worksheets/sheet${i + 1}.xml`;
    const sheetXml = await read(path);
    sheets.push({ name, rows: sheetXml ? parseSheet(sheetXml, sharedStrings) : [] });
  }

  if (sheets.length === 0) throw new Error('The workbook contains no worksheets.');
  return { sheets };
}

/* ------------------------------------------------------------------ *
 * Delimited text (.csv / .tsv / .txt)
 * ------------------------------------------------------------------ */

function detectDelimiter(text) {
  const sample = text.slice(0, 8192);
  const counts = [
    [',', (sample.match(/,/g) || []).length],
    [';', (sample.match(/;/g) || []).length],
    ['\t', (sample.match(/\t/g) || []).length],
  ].sort((a, b) => b[1] - a[1]);
  return counts[0][1] > 0 ? counts[0][0] : ',';
}

/** RFC 4180-style parser: quoted fields, doubled quotes, CRLF or LF. */
export function parseDelimited(text, delimiter = null) {
  const clean = text.replace(/^﻿/, '');
  const sep = delimiter || detectDelimiter(clean);

  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < clean.length; i += 1) {
    const ch = clean[i];

    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') { field += '"'; i += 1; } else { quoted = false; }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"' && field === '') { quoted = true; continue; }
    if (ch === sep) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }

  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === '')) rows.pop();
  return rows;
}

/** True when the name looks like something parseDelimited should handle. */
export function isDelimitedFile(fileName) {
  return /\.(csv|tsv|txt)$/i.test(fileName);
}
