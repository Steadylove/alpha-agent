const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3,
  apr: 4, april: 4, may: 5, jun: 6, june: 6, jul: 7, july: 7,
  aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const MONTH_NAME = "Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?";

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function calendarDate(year: number, month: number, day: number): string | undefined {
  const date = new Date(Date.UTC(year, month - 1, day));
  if (year < 2000 || year > 2199 || date.getUTCFullYear() !== year || date.getUTCMonth() + 1 !== month || date.getUTCDate() !== day) return undefined;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** Match the next stated month/day; explicit years are never rewritten. */
function inferYear(asOf: string, month: number, day: number): number {
  const [year, asOfMonth, asOfDay] = asOf.split("-").map(Number);
  return month < asOfMonth || (month === asOfMonth && day < asOfDay) ? year + 1 : year;
}
function monthNum(name: string): number | undefined {
  return MONTHS[name.toLowerCase().replace(/^sept$/i, "sep")];
}

/** Consistent display while preserving source precision: never invent an expiry Friday. */
export function normalizeExpiry(raw: string | undefined, asOf: string): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  const session = /^(\d{4})-(\d{2})-(\d{2})$/.exec(asOf);
  const validSession = session && calendarDate(Number(session[1]), Number(session[2]), Number(session[3]));
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t);
  if (iso) return calendarDate(Number(iso[1]), Number(iso[2]), Number(iso[3]));
  if (/^0DTE$/i.test(t)) return validSession || "当日到期";
  const slash = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?$/);
  if (slash) {
    const month = Number(slash[1]), day = Number(slash[2]);
    if (!slash[3] && !validSession) return undefined;
    let year = slash[3] ? Number(slash[3]) : inferYear(asOf, month, day);
    if (year < 100) year += 2000;
    return calendarDate(year, month, day);
  }
  const monthYear = t.match(new RegExp(`^(${MONTH_NAME})\\.?\\s+(?:'(?:20)?(\\d{2})|(20\\d{2}))$`, "i"));
  if (monthYear) {
    const month = monthNum(monthYear[1]);
    const yy = monthYear[2] || monthYear[3];
    if (month && yy) return `${yy.length === 4 ? yy : `20${yy}`}-${pad(month)}（月）`;
  }
  const monthDay = t.match(new RegExp(`^(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(20\\d{2}))?$`, "i"));
  if (monthDay) {
    const month = monthNum(monthDay[1]), day = Number(monthDay[2]);
    if (month && (monthDay[3] || validSession)) return calendarDate(monthDay[3] ? Number(monthDay[3]) : inferYear(asOf, month, day), month, day);
  }
  const monthOnly = t.match(new RegExp(`^(${MONTH_NAME})$`, "i"));
  const month = monthOnly ? monthNum(monthOnly[1]) : /^\d{1,2}$/.test(t) ? Number(t) : undefined;
  if (month && month <= 12) return `${pad(month)} 月（年份未明）`;
  if (/^two weeks$/i.test(t)) return "约 2 周后";
  if (/^next week$/i.test(t)) return "下周（日期未明）";
  const weeks = t.match(/^(\d+) weeks$/i);
  if (weeks) return `约 ${Number(weeks[1])} 周后`;
  if (/^next-year$/i.test(t)) return validSession ? `${Number(asOf.slice(0, 4)) + 1} 年（日期未明）` : "次年（日期未明）";
  if (/^LEAPS$/i.test(t)) return "长期（日期未明）";
  return undefined;
}

export function expirySpecificity(raw?: string): number {
  if (!raw) return 0;
  if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(raw.trim())) return 3;
  if (new RegExp(`^(${MONTH_NAME})\\.?\\s+(?:'(?:20)?\\d{2}|20\\d{2})$`, "i").test(raw.trim())) return 2;
  if (new RegExp(`^(${MONTH_NAME})\\.?\\s+\\d{1,2}`, "i").test(raw.trim())) return 2;
  return 1;
}
