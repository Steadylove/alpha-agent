import type { LookbackTf } from "./lookbackLogic";

const DAY = /^\d{4}-\d{2}-\d{2}$/;

export type BookEpoch = {
  from: string;
  resetAt: string;
};

export type BookEpochs = Record<LookbackTf, BookEpoch>;
export type BookEpochState = BookEpoch & { epochs: BookEpochs; updatedAt: string };

export function normalizeBookFrom(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const day = raw.trim().slice(0, 10);
  if (!DAY.test(day)) return null;
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === day ? day : null;
}

/** 旧文件的一份起点分别承接到两个周期；读取本身不重置账本。 */
export function bookEpochStateOf(raw: unknown, fallbackFrom: string): BookEpochState {
  const legacy = bookEpochOf(raw, fallbackFrom);
  const row = raw as Partial<BookEpochState> | null;
  const epochs: BookEpochs = { "4h": { ...legacy }, "2h": { ...legacy } };
  if (row?.epochs != null) {
    for (const tf of ["4h", "2h"] as const) {
      const epoch = row.epochs[tf];
      if (!epoch || !normalizeBookFrom(epoch.from) || typeof epoch.resetAt !== "string") {
        throw new Error(`${tf.toUpperCase()} 记账起点无效，原账本未重置`);
      }
      epochs[tf] = bookEpochOf(epoch, fallbackFrom);
    }
  }
  // 顶层字段仅为旧格式兼容；所有记账逻辑按 epochs 分周期读取。
  return { ...epochs["4h"], epochs, updatedAt: typeof row?.updatedAt === "string" ? row.updatedAt : "" };
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
