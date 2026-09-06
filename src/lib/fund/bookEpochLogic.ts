const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type BookEpoch = {
  from: string;
  resetAt: string;
};

export function normalizeBookFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const day = raw.trim().slice(0, 10);
  return DAY.test(day) ? day : null;
}

export function bookEpochOf(raw: unknown, fallbackFrom: string): BookEpoch {
  if (typeof raw !== "object" || raw === null) {
    return { from: fallbackFrom, resetAt: "" };
  }
  const p = raw as Partial<BookEpoch>;
  return {
    from: normalizeBookFrom(p.from) ?? fallbackFrom,
    resetAt: typeof p.resetAt === "string" ? p.resetAt : "",
  };
}
