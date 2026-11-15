const zlib = require('node:zlib');

// Minimale xlsx-lezer zonder afhankelijkheden: een xlsx is een zip met XML. We lezen alleen wat nodig is (werkbladnamen, gedeelde teksten en de
// cellen van gevraagde bladen) en nemen bij formules de laatst berekende waarde. Alleen lezen; er wordt nooit iets uitgevoerd.
const MAX_FILE = 25 * 1024 * 1024;      // de zip zelf
const MAX_PART = 40 * 1024 * 1024;      // één uitgepakt onderdeel (tegen zip-bommen)

class XlsxError extends Error {}

function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22 || buf.length > MAX_FILE) throw new XlsxError('Het bestand is leeg of te groot.');
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new XlsxError('Dit is geen geldig Excel-bestand (.xlsx).');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const parts = new Map();
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new XlsxError('Dit is geen geldig Excel-bestand (.xlsx).');
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    parts.set(name, { method, csize, off });
    p += 46 + nlen + elen + clen;
  }
  return (name) => {
    const e = parts.get(name);
    if (!e) return null;
    if (e.off + 30 > buf.length || buf.readUInt32LE(e.off) !== 0x04034b50) throw new XlsxError('Beschadigd Excel-bestand.');
    const start = e.off + 30 + buf.readUInt16LE(e.off + 26) + buf.readUInt16LE(e.off + 28);
    const raw = buf.subarray(start, start + e.csize);
    if (e.method === 0) return raw.toString('utf8');
    if (e.method === 8) {
      try { return zlib.inflateRawSync(raw, { maxOutputLength: MAX_PART }).toString('utf8'); } catch (err) { throw new XlsxError('Beschadigd of te groot Excel-bestand.'); }
    }
    throw new XlsxError('Niet-ondersteunde compressie in het Excel-bestand.');
  };
}

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
  const k = e.toLowerCase();
  if (k === 'amp') return '&'; if (k === 'lt') return '<'; if (k === 'gt') return '>'; if (k === 'quot') return '"'; if (k === 'apos') return "'";
  const code = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
  return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : '';
});
const texts = (xml) => [...xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/g)].map((m) => decode(m[1])).join('');
const attr = (s, name) => { const m = new RegExp(`\\b${name}="([^"]*)"`).exec(s); return m ? decode(m[1]) : null; };

function colIndex(letters) { let n = 0; for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64; return n; }

// Geeft { sheets: [{ name, hidden }], read(name) -> Map "rij,kolom" -> string | number }
function openWorkbook(buf) {
  const file = readZip(buf);
  const wb = file('xl/workbook.xml'), rels = file('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw new XlsxError('Dit is geen geldig Excel-bestand (.xlsx).');
  const targets = new Map([...rels.matchAll(/<Relationship\b([^>]*)\/?>/g)].map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const sheets = [...wb.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const rid = attr(m[1], 'r:id'), t = targets.get(rid) || '';
    return { name: attr(m[1], 'name'), hidden: (attr(m[1], 'state') || 'visible') !== 'visible', path: t.startsWith('/') ? t.slice(1) : `xl/${t}` };
  });
  const ssXml = file('xl/sharedStrings.xml');
  const shared = ssXml ? [...ssXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map((m) => texts(m[1])) : [];
  return {
    sheets,
    read(name) {
      const sh = sheets.find((s) => s.name === name);
      const xml = sh && file(sh.path);
      if (!xml) throw new XlsxError(`Blad "${name}" ontbreekt.`);
      const cells = new Map();
      for (const m of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /^([A-Z]+)(\d+)$/.exec(attr(m[1], 'r') || '');
        if (!ref || m[2] === undefined) continue;
        const type = attr(m[1], 't'), v = /<v>([\s\S]*?)<\/v>/.exec(m[2]);
        let value = null;
        if (type === 'inlineStr') value = texts(m[2]);
        else if (v) {
          const raw = decode(v[1]);
          if (type === 's') value = shared[Number(raw)] ?? null;
          else if (type === 'str') value = raw;
          else if (type === 'b' || type === 'e') value = null;
          else { const num = Number(raw); value = Number.isFinite(num) ? num : null; }
        }
        if (value !== null && value !== '') cells.set(`${ref[2]},${colIndex(ref[1])}`, value);
      }
      return cells;
    },
  };
}

module.exports = { openWorkbook, XlsxError, colIndex };
