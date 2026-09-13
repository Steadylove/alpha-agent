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

export function formatMdY(year: number, month: number, day: number): string {
  return `${pad(month)}/${pad(day)}/${String(year).slice(-2)}`;
}

function thirdFriday(year: number, month: number): { year: number; month: number; day: number } {
  const dow = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
  const firstFriday = dow <= 5 ? 1 + (5 - dow) : 1 + (12 - dow);
  const day = firstFriday + 14;
  return { year, month, day };
}

function inferYear(asOf: string, month: number, day: number): number {
  const [year, asOfMonth, asOfDay] = asOf.split("-").map(Number);
  if (month < asOfMonth || (month === asOfMonth && day < asOfDay)) return year + 1;
  return year;
}

function shiftDay(asOf: string, days: number): string {
  const dt = new Date(`${asOf}T12:00:00Z`);
  dt.setUTCDate(dt.getUTCDate() + days);
  return formatMdY(dt.getUTCFullYear(), dt.getUTCMonth() + 1, dt.getUTCDate());
}

function monthNum(name: string): number | undefined {
  return MONTHS[name.toLowerCase().replace(/^sept$/i, "sep")];
}

/** 日结统一成 MM/DD/YY。月份按当月第三周五；「两周内」按会话日加天数。 */
export function normalizeExpiry(raw: string | undefined, asOf: string): string | undefined {
  if (!raw) return undefined;
  const t = raw.trim();
  if (/^0DTE$/i.test(t)) {
    const [year, month, day] = asOf.split("-").map(Number);
    return formatMdY(year, month, day);
  }
  const slash = t.match(/^(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?$/);
  if (slash) {
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    let year = slash[3] ? Number(slash[3]) : inferYear(asOf, month, day);
    if (year < 100) year += 2000;
    return formatMdY(year, month, day);
  }
  const monthYear = t.match(new RegExp(`^(${MONTH_NAME})\\.?\\s+(?:'(?:20)?(\\d{2})|(20\\d{2}))$`, "i"));
  if (monthYear) {
    const month = monthNum(monthYear[1]);
    const yy = monthYear[2] || monthYear[3] || "";
    if (month && yy) {
      const year = yy.length === 4 ? Number(yy) : 2000 + Number(yy);
      const fri = thirdFriday(year, month);
      return formatMdY(fri.year, fri.month, fri.day);
    }
  }
  const monthDay = t.match(new RegExp(`^(${MONTH_NAME})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?$`, "i"));
  if (monthDay) {
    const month = monthNum(monthDay[1]);
    const day = Number(monthDay[2]);
    if (month) return formatMdY(inferYear(asOf, month, day), month, day);
  }
  const monthOnly = t.match(new RegExp(`^(${MONTH_NAME})$`, "i"));
  if (monthOnly) {
    const month = monthNum(monthOnly[1]);
    if (month) {
      const [year, asOfMonth] = asOf.split("-").map(Number);
      const fri = thirdFriday(month < asOfMonth ? year + 1 : year, month);
      return formatMdY(fri.year, fri.month, fri.day);
    }
  }
  if (/^two weeks$/i.test(t)) return shiftDay(asOf, 14);
  if (/^next week$/i.test(t)) return shiftDay(asOf, 7);
  const weeks = t.match(/^(\d+) weeks$/i);
  if (weeks) return shiftDay(asOf, Number(weeks[1]) * 7);
  return undefined;
}

export function expirySpecificity(raw?: string): number {
  if (!raw) return 0;
  if (/^\d{1,2}\/\d{1,2}(?:\/\d{2,4})?$/.test(raw.trim())) return 3;
  if (new RegExp(`^(${MONTH_NAME})\\.?\\s+(?:'(?:20)?\\d{2}|20\\d{2})$`, "i").test(raw.trim())) return 2;
  if (new RegExp(`^(${MONTH_NAME})\\.?\\s+\\d{1,2}`, "i").test(raw.trim())) return 2;
  return 1;
}
