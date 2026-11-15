const zlib = require('node:zlib');

// Bouwt een minimale .xlsx (zip met XML) voor tests: sheets = { naam: { 'B2': waarde | { f: 'formule', v: waarde } } }.
// Teksten gaan via de gedeelde tekstentabel (zoals Excel dat doet), getallen als getal.
function zip(files) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8'), comp = zlib.deflateRawSync(data), nameBuf = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(zlib.crc32(data), 14); local.writeUInt32LE(comp.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26);
    parts.push(local, nameBuf, comp);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(zlib.crc32(data), 16); c.writeUInt32LE(comp.length, 20); c.writeUInt32LE(data.length, 24); c.writeUInt16LE(nameBuf.length, 28); c.writeUInt32LE(offset, 42);
    central.push(c, nameBuf);
    offset += 30 + nameBuf.length + comp.length;
  }
  const cd = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function xlsx(sheets, { hidden = [] } = {}) {
  const shared = [], idx = new Map();
  const sst = (s) => { if (!idx.has(s)) { idx.set(s, shared.length); shared.push(s); } return idx.get(s); };
  const names = Object.keys(sheets);
  const sheetXml = names.map((n) => {
    const rows = new Map();
    for (const [ref, val] of Object.entries(sheets[n])) {
      const m = /^([A-Z]+)(\d+)$/.exec(ref);
      if (!rows.has(+m[2])) rows.set(+m[2], []);
      rows.get(+m[2]).push([m[1], val]);
    }
    const body = [...rows.entries()].sort((a, b) => a[0] - b[0]).map(([r, cs]) => `<row r="${r}">${cs.map(([col, val]) => {
      const f = val && typeof val === 'object' ? `<f>${esc(val.f)}</f>` : '', v = val && typeof val === 'object' ? val.v : val;
      return typeof v === 'string' ? `<c r="${col}${r}" t="s">${f}<v>${sst(v)}</v></c>` : `<c r="${col}${r}">${f}<v>${v}</v></c>`;
    }).join('')}</row>`).join('');
    return `<?xml version="1.0"?><worksheet><sheetData>${body}<row r="999"><c r="A999" s="1"/></row></sheetData></worksheet>`;
  });
  const files = {
    '[Content_Types].xml': '<Types/>',
    'xl/workbook.xml': `<?xml version="1.0"?><workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${esc(n)}" sheetId="${i + 1}"${hidden.includes(n) ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets></workbook>`,
    'xl/_rels/workbook.xml.rels': `<?xml version="1.0"?><Relationships>${names.map((n, i) => `<Relationship Id="rId${i + 1}" Type="x" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}</Relationships>`,
  };
  sheetXml.forEach((x, i) => { files[`xl/worksheets/sheet${i + 1}.xml`] = x; });
  files['xl/sharedStrings.xml'] = `<?xml version="1.0"?><sst>${shared.map((s) => `<si><t>${esc(s)}</t></si>`).join('')}</sst>`;
  return zip(files);
}

const serial = (iso) => Math.round(Date.UTC(+iso.slice(0, 4), +iso.slice(5, 7) - 1, +iso.slice(8, 10)) / 86400000) + 25569;
const time = (hhmm) => { const [h, m] = hhmm.split(':').map(Number); return (h * 60 + m) / 1440; };

module.exports = { xlsx, serial, time };
