// Aansluiting van de gastouder bij gastouderbureaus, met periodes (van en t/m, leeg = open) en de controle op het maximum.
// Wet kinderopvang art. 1.56c (Stb. 2025, 164): een gastouder is per voorziening aangesloten bij ten hoogste twee gastouderbureaus; bij een
// overstap mag tijdelijk een derde (Besluit Stb. 2025, 427); overschrijdingen die voortkomen uit overeenkomsten tussen ouders en bureau van vóór de
// inwerkingtreding mogen blijven bestaan (art. 3.2c). De ingangsdatum hieronder (1 juli 2026) komt uit de VNG en de Rijksoverheid maar is niet
// in het Staatsblad zelf nagelopen: pas LIMIT.from aan als het koninklijk besluit iets anders zegt.
const LIMIT = { max: 2, from: '2026-07-01' };
const OPEN_START = '0000-01-01', OPEN_END = '9999-12-31';

// Periodes waarin er meer dan LIMIT.max verschillende bureaus tegelijk zijn, vanaf LIMIT.from: [{ from, to, count }] (null = open einde).
function overLimit(links, limit = LIMIT) {
  const spans = (links || []).map((l) => ({ id: l.agencyId, a: l.from || OPEN_START, b: l.to || OPEN_END })).filter((s) => s.a <= s.b);
  const cuts = [...new Set([limit.from, ...spans.flatMap((s) => [s.a, nextDay(s.b)])])].filter((d) => d >= limit.from).sort();
  const out = [];
  cuts.forEach((start, i) => {
    const end = i + 1 < cuts.length ? prevDay(cuts[i + 1]) : OPEN_END;
    const count = new Set(spans.filter((s) => s.a <= start && start <= s.b).map((s) => s.id)).size;
    if (count <= limit.max) return;
    const last = out[out.length - 1];
    if (last && last.count === count && nextDay(last.to || OPEN_END) === start) last.to = end === OPEN_END ? null : end;
    else out.push({ from: start, to: end === OPEN_END ? null : end, count });
  });
  return out;
}
function nextDay(d) { if (d >= OPEN_END) return OPEN_END; const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); }
function prevDay(d) { const x = new Date(`${d}T12:00:00Z`); x.setUTCDate(x.getUTCDate() - 1); return x.toISOString().slice(0, 10); }

module.exports = { LIMIT, overLimit };
