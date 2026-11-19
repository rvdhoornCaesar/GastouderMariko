const { CARE_TYPES } = require('./validation');
const { overLimit } = require('./agency-links');

// Soorten opvang (gastouder en bso). Een gastouderbureau doet één of beide; de gastouder kiest zelf welke ze doet (daarbinnen).
//   beschikbaar = de soorten van de bureaus waarbij ze is aangesloten (in welke periode ook)
//   gekozen     = wat ze zelf heeft aangevinkt (null = nog niet gekozen: dan alle beschikbare soorten)
//   actief      = gekozen binnen beschikbaar; zolang er nog geen bureau is gekozen geldt alleen gastouder (zoals het altijd was)
const typesOf = (agency) => (agency && agency.types && agency.types.length ? agency.types : ['gastouder']);

function careInfo(links, agencies, chosen) {
  const byId = new Map(agencies.map((a) => [a.id, a]));
  const available = CARE_TYPES.filter((t) => (links || []).some((l) => typesOf(byId.get(l.agencyId)).includes(t)));
  const enabled = (links || []).length ? (chosen ? CARE_TYPES.filter((t) => chosen.includes(t) && available.includes(t)) : available) : ['gastouder'];
  return { availableTypes: available, careTypes: chosen || null, enabledTypes: enabled };
}

// Het maximum van twee bureaus telt per soort opvang (een bureau dat beide doet telt voor beide).
function warningsOf(links, agencies) {
  const byId = new Map(agencies.map((a) => [a.id, a]));
  return CARE_TYPES.flatMap((t) => overLimit((links || []).filter((l) => typesOf(byId.get(l.agencyId)).includes(t))).map((w) => ({ ...w, type: t })));
}

module.exports = { careInfo, warningsOf, typesOf };
