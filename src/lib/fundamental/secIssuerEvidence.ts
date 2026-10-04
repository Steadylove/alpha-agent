type Json = Record<string, unknown>;
const object = (value: unknown): Json => value && typeof value === "object" && !Array.isArray(value) ? value as Json : {};
const text = (value: unknown) => typeof value === "string" ? value.trim() : "";
const date = (value: unknown): string | null => {
  const valueText = text(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(valueText) && Number.isFinite(Date.parse(valueText)) &&
    new Date(valueText).toISOString().slice(0, 10) === valueText ? valueText : null;
};

export type SecIncorporationFiling = { url: string; accn: string; filedAt: string };

/** Select only an official document of the already matched operating issuer. Never guess its jurisdiction from its address. */
export function selectSecIncorporationFiling(meta: unknown, cik: string, today: string): SecIncorporationFiling | null {
  const issuer = object(meta), issuerCik = String(issuer.cik ?? "");
  if (!/^\d{1,10}$/.test(cik) || Number(cik) <= 0 || !/^\d{1,10}$/.test(issuerCik) ||
    issuerCik.padStart(10, "0") !== cik.padStart(10, "0") || text(issuer.entityType) !== "operating" ||
    text(issuer.stateOfIncorporation) || !date(today)) return null;
  const recent = object(object(issuer.filings).recent);
  const forms = Array.isArray(recent.form) ? recent.form : [];
  const dates = Array.isArray(recent.filingDate) ? recent.filingDate : [];
  const accessions = Array.isArray(recent.accessionNumber) ? recent.accessionNumber : [];
  const documents = Array.isArray(recent.primaryDocument) ? recent.primaryDocument : [];
  const known = forms.map((form, index) => ({ form: text(form), index, filedAt: date(dates[index]) }))
    .filter((row): row is { form: string; index: number; filedAt: string } => row.filedAt !== null && row.filedAt < today);
  if (known.some(row => /^(20-F|40-F|6-K)(\/A)?$/.test(row.form))) return null;
  const latest = known.filter(row => /^10-K(\/A)?$/.test(row.form))
    .sort((a, b) => b.filedAt.localeCompare(a.filedAt) || text(accessions[b.index]).localeCompare(text(accessions[a.index])))[0];
  if (!latest) return null;
  const accn = text(accessions[latest.index]), document = text(documents[latest.index]);
  // Accession prefixes can belong to filing agents, so the issuer CIK comes from submissions.
  if (!/^\d{10}-\d{2}-\d{6}$/.test(accn) || !/^[a-z0-9][a-z0-9._-]*\.html?$/i.test(document) || document.includes("..")) return null;
  return { url: `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${accn.replace(/-/g, "")}/${document}`,
    accn, filedAt: latest.filedAt };
}

export const SEC_INCORPORATION_DOCUMENT_MAX_BYTES = 12 * 1024 * 1024;
const stateNames: Record<string, string> = {
  AL: "Alabama", AK: "Alaska", AZ: "Arizona", AR: "Arkansas", CA: "California", CO: "Colorado", CT: "Connecticut",
  DE: "Delaware", DC: "District of Columbia", FL: "Florida", GA: "Georgia", HI: "Hawaii", ID: "Idaho", IL: "Illinois",
  IN: "Indiana", IA: "Iowa", KS: "Kansas", KY: "Kentucky", LA: "Louisiana", ME: "Maine", MD: "Maryland",
  MA: "Massachusetts", MI: "Michigan", MN: "Minnesota", MS: "Mississippi", MO: "Missouri", MT: "Montana",
  NE: "Nebraska", NV: "Nevada", NH: "New Hampshire", NJ: "New Jersey", NM: "New Mexico", NY: "New York",
  NC: "North Carolina", ND: "North Dakota", OH: "Ohio", OK: "Oklahoma", OR: "Oregon", PA: "Pennsylvania",
  RI: "Rhode Island", SC: "South Carolina", SD: "South Dakota", TN: "Tennessee", TX: "Texas", UT: "Utah",
  VT: "Vermont", VA: "Virginia", WA: "Washington", WV: "West Virginia", WI: "Wisconsin", WY: "Wyoming",
};
const stateCodes = new Map(Object.entries(stateNames).flatMap(([code, name]) => [[code.toLowerCase(), code], [name.toLowerCase(), code]]));

function decodeEntities(value: string): string | null {
  let valid = true;
  const named: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
  const decoded = value.replace(/&([^;\s]+);/g, (_, entity: string) => {
    if (Object.hasOwn(named, entity)) return named[entity];
    const numeric = /^#(?:[0-9]+|x[0-9a-f]+)$/i.test(entity);
    const code = numeric ? Number.parseInt(entity.slice(/^#x/i.test(entity) ? 2 : 1), /^#x/i.test(entity) ? 16 : 10) : NaN;
    if (!Number.isInteger(code) || code <= 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) { valid = false; return ""; }
    return String.fromCodePoint(code);
  });
  return valid ? decoded : null;
}

function attributes(raw: string): Map<string, string> | null {
  const values = new Map<string, string>();
  for (const match of raw.matchAll(/([a-z_:][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const name = match[1].toLowerCase(), value = decodeEntities(match[2] ?? match[3]);
    if (values.has(name) || value === null) return null;
    values.set(name, value);
  }
  return values;
}

/** Bounded inline-XBRL field reader, not a general HTML parser. Unknown transforms or conflicting jurisdiction facts remain unavailable. */
export function parseSecIncorporationState(html: string): string | null {
  if (html.length > SEC_INCORPORATION_DOCUMENT_MAX_BYTES || Buffer.byteLength(html, "utf8") > SEC_INCORPORATION_DOCUMENT_MAX_BYTES) return null;
  const document = html.replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const states = new Set<string>();
  for (const match of document.matchAll(/<ix:nonNumeric\b([^>]*)>([\s\S]*?)<\/ix:nonNumeric\s*>/gi)) {
    const values = attributes(match[1]);
    if (!values) return null;
    if (values.get("name") !== "dei:EntityIncorporationStateCountryCode") continue;
    const format = values.get("format"), nil = values.get("xsi:nil");
    if (!values.get("contextref") || values.has("continuedat") || (nil !== undefined && nil !== "false" && nil !== "0") ||
      (format !== undefined && format !== "ixt-sec:stateprovnameen")) return null;
    const decoded = decodeEntities(match[2].replace(/<[^>]*>/g, " "));
    const code = decoded === null ? undefined : stateCodes.get(decoded.replace(/\s+/g, " ").trim().toLowerCase());
    if (!code) return null;
    states.add(code);
    if (states.size > 1) return null;
  }
  return states.size === 1 ? [...states][0] : null;
}
