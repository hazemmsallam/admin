/**
 * Builds .xlsx bytes the way Excel lays them out (ZIP + SpreadsheetML), so the
 * reader can be exercised without checking a binary file into the repository.
 *
 * Writing a workbook is not something the tool itself needs, so this lives in
 * test/ rather than src/.
 *
 * Run directly to drop a sample file on disk:
 *   node test/fixtures.js sample.xlsx
 */

import zlib from 'node:zlib';
import { realpathSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c;
  }
  return table;
})();

function crc32(buffer) {
  let crc = -1;
  for (let i = 0; i < buffer.length; i += 1) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buffer[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** @param {Array<{name: string, content: string}>} files */
export function makeZip(files) {
  const local = [];
  const central = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = Buffer.from(file.content, 'utf8');
    const compressed = zlib.deflateRawSync(data);
    const crc = crc32(data);

    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt16LE(8, 8); // deflate
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(compressed.length, 18);
    header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(name.length, 26);
    local.push(header, name, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);

    offset += header.length + name.length + compressed.length;
  }

  const directory = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(directory.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...local, directory, eocd]);
}

const NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

const escapeXml = (text) => String(text)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * A single-sheet workbook with one header cell and one MSISDN per row,
 * written as inline strings so long numbers stay exact.
 */
export function workbookFromMsisdns(msisdns, { sheetName = 'Subscribers', header = 'MSISDN' } = {}) {
  const rows = [header, ...msisdns].map((value, index) => (
    `<row r="${index + 1}"><c r="A${index + 1}" t="inlineStr"><is><t>${escapeXml(value)}</t></is></c></row>`
  )).join('');

  return makeZip([
    {
      name: '[Content_Types].xml',
      content: '<?xml version="1.0" encoding="UTF-8"?><Types '
        + 'xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" `
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + `<sheets><sheet name="${escapeXml(sheetName)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: '<?xml version="1.0" encoding="UTF-8"?><Relationships '
        + 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData>${rows}</sheetData></worksheet>`,
    },
  ]);
}

/**
 * Exercises the awkward corners of the format: shared strings, rich-text runs,
 * entities, a raw numeric cell, an inline string and a sparse row.
 */
export function sampleWorkbook() {
  return makeZip([
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${NS}" `
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets><sheet name="Subscribers" sheetId="1" r:id="rId1"/>'
        + '<sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>',
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: '<?xml version="1.0" encoding="UTF-8"?><Relationships '
        + 'xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Target="worksheets/sheet1.xml"/>'
        + '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>',
    },
    {
      name: 'xl/sharedStrings.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${NS}" count="3" uniqueCount="3">`
        + '<si><t>MSISDN</t></si><si><t>962791234567</t></si>'
        + '<si><r><t>Owner</t></r><r><t> &amp; agent</t></r></si></sst>',
    },
    {
      name: 'xl/worksheets/sheet1.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData>`
        + '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>2</v></c></row>'
        + '<row r="2"><c r="A2" t="s"><v>1</v></c></row>'
        + '<row r="3"><c r="A3"><v>962791234568</v></c></row>'
        + '<row r="4"><c r="A4" t="inlineStr"><is><t>+962 79 123 4569</t></is></c></row>'
        + '<row r="5"><c r="A5"/><c r="C5"><v>7</v></c></row>'
        + '</sheetData></worksheet>',
    },
    {
      name: 'xl/worksheets/sheet2.xml',
      content: `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="${NS}"><sheetData/></worksheet>`,
    },
  ]);
}

// node test/fixtures.js [out.xlsx] [count]
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [, , out = 'sample-msisdns.xlsx', count = '5'] = process.argv;
  const msisdns = Array.from({ length: Number(count) }, (_, i) => String(962791234567 + i));
  writeFileSync(out, workbookFromMsisdns(msisdns));
  process.stdout.write(`Wrote ${out} with ${msisdns.length} MSISDNs\n`);
}
