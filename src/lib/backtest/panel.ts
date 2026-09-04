/**
 * 回测面板的二进制编解码与载入。
 *
 * 序列以定长小端数组存储：日期为 Int32（自 1970-01-01 起的天数），
 * 高/低/收为 Float32。Float32 有约 7 位有效十进制数字，对美股价格
 * （最高约 5 位整数 + 2 位小数）够用，且比 Float64 省一半空间。
 */

export type PanelBars = {
  ticker: string;
  /** ISO 日期，升序 */
  dates: string[];
  high: Float32Array;
  low: Float32Array;
  close: Float32Array;
  /**
   * 成交股数。Float32 的相对精度约 1e-7，一亿股的误差在十股量级，
   * 用于成交额门槛比较完全够。
   *
   * 为 null 表示该标的是加 volume 列之前回填的，尚未补齐。
   */
  volume: Float32Array | null;
  /**
   * 开盘价。只被顶背离用到（通达信原式的 `TP_P := MAX(C, O)` 取实体上沿）。
   *
   * 为 null 表示该标的是加 open 列之前回填的，此时实体上沿退化为收盘价。
   */
  open: Float32Array | null;
};

const MS_PER_DAY = 86_400_000;

const dayNumber = (iso: string) => Math.round(Date.parse(`${iso}T00:00:00.000Z`) / MS_PER_DAY);
const isoFromDayNumber = (n: number) => new Date(n * MS_PER_DAY).toISOString().slice(0, 10);

export type PackedPanel = {
  days: Uint8Array<ArrayBuffer>;
  high: Uint8Array<ArrayBuffer>;
  low: Uint8Array<ArrayBuffer>;
  close: Uint8Array<ArrayBuffer>;
  volume: Uint8Array<ArrayBuffer>;
  open: Uint8Array<ArrayBuffer>;
  barCount: number;
  firstDate: Date;
  lastDate: Date;
};

/** Prisma 的 Bytes 列要求 `Uint8Array<ArrayBuffer>`，不接受 Node 的 Buffer。 */
const allocBytes = (n: number) => {
  const bytes = new Uint8Array(new ArrayBuffer(n * 4));
  return { bytes, view: new DataView(bytes.buffer) };
};

export function packPanel(
  bars: readonly {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[],
): PackedPanel {
  const n = bars.length;
  if (n === 0) throw new Error("packPanel: 空序列");

  const days = allocBytes(n);
  const high = allocBytes(n);
  const low = allocBytes(n);
  const close = allocBytes(n);
  const volume = allocBytes(n);
  const open = allocBytes(n);

  for (let i = 0; i < n; i += 1) {
    days.view.setInt32(i * 4, dayNumber(bars[i].date), true);
    high.view.setFloat32(i * 4, bars[i].high, true);
    low.view.setFloat32(i * 4, bars[i].low, true);
    close.view.setFloat32(i * 4, bars[i].close, true);
    volume.view.setFloat32(i * 4, bars[i].volume, true);
    open.view.setFloat32(i * 4, bars[i].open, true);
  }

  return {
    days: days.bytes,
    high: high.bytes,
    low: low.bytes,
    close: close.bytes,
    volume: volume.bytes,
    open: open.bytes,
    barCount: n,
    firstDate: new Date(`${bars[0].date}T00:00:00.000Z`),
    lastDate: new Date(`${bars[n - 1].date}T00:00:00.000Z`),
  };
}

/** Buffer 到 TypedArray：Prisma 返回的 Buffer 可能不是 4 字节对齐，必须拷贝。 */
function toFloat32(buf: Uint8Array): Float32Array {
  const out = new Float32Array(buf.byteLength / 4);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  for (let i = 0; i < out.length; i += 1) out[i] = view.getFloat32(i * 4, true);
  return out;
}

export function unpackPanel(row: {
  ticker: string;
  days: Uint8Array;
  high: Uint8Array;
  low: Uint8Array;
  close: Uint8Array;
  volume?: Uint8Array | null;
  open?: Uint8Array | null;
}): PanelBars {
  const view = new DataView(row.days.buffer, row.days.byteOffset, row.days.byteLength);
  const n = row.days.byteLength / 4;
  const dates: string[] = new Array(n);
  for (let i = 0; i < n; i += 1) dates[i] = isoFromDayNumber(view.getInt32(i * 4, true));

  return {
    ticker: row.ticker,
    dates,
    high: toFloat32(row.high),
    low: toFloat32(row.low),
    close: toFloat32(row.close),
    volume: row.volume ? toFloat32(row.volume) : null,
    open: row.open ? toFloat32(row.open) : null,
  };
}

/**
 * 盘中时刻。CSV / 引擎用 `YYYY-MM-DDTHH:mm`，按 UTC 解析（与 hoursBetween 相同）。
 * 日线 BacktestPanel 的 days 是日序号，同一天多根会塌成一根，盘中必须用分钟。
 */
export function barEpochMs(date: string): number {
  if (!date.includes("T")) return Date.parse(`${date}T00:00:00Z`);
  const iso = date.length === 16 ? `${date}:00Z` : date.endsWith("Z") ? date : `${date}Z`;
  return Date.parse(iso);
}

function isoMinuteUtc(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

export type PackedTimedPanel = {
  times: Uint8Array<ArrayBuffer>;
  high: Uint8Array<ArrayBuffer>;
  low: Uint8Array<ArrayBuffer>;
  close: Uint8Array<ArrayBuffer>;
  volume: Uint8Array<ArrayBuffer>;
  open: Uint8Array<ArrayBuffer>;
  barCount: number;
  firstDate: Date;
  lastDate: Date;
};

export function packTimedPanel(
  bars: readonly {
    date: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  }[],
): PackedTimedPanel {
  const n = bars.length;
  if (n === 0) throw new Error("packTimedPanel: 空序列");

  const times = allocBytes(n);
  const high = allocBytes(n);
  const low = allocBytes(n);
  const close = allocBytes(n);
  const volume = allocBytes(n);
  const open = allocBytes(n);

  for (let i = 0; i < n; i += 1) {
    const ms = barEpochMs(bars[i].date);
    if (!Number.isFinite(ms)) throw new Error(`packTimedPanel: 坏日期 ${bars[i].date}`);
    times.view.setInt32(i * 4, Math.round(ms / 60_000), true);
    high.view.setFloat32(i * 4, bars[i].high, true);
    low.view.setFloat32(i * 4, bars[i].low, true);
    close.view.setFloat32(i * 4, bars[i].close, true);
    volume.view.setFloat32(i * 4, bars[i].volume, true);
    open.view.setFloat32(i * 4, bars[i].open, true);
  }

  const first = barEpochMs(bars[0].date);
  const last = barEpochMs(bars[n - 1].date);
  return {
    times: times.bytes,
    high: high.bytes,
    low: low.bytes,
    close: close.bytes,
    volume: volume.bytes,
    open: open.bytes,
    barCount: n,
    firstDate: new Date(first),
    lastDate: new Date(last),
  };
}

export function unpackTimedPanel(row: {
  ticker: string;
  times: Uint8Array;
  high: Uint8Array;
  low: Uint8Array;
  close: Uint8Array;
  volume?: Uint8Array | null;
  open?: Uint8Array | null;
}): PanelBars {
  const view = new DataView(row.times.buffer, row.times.byteOffset, row.times.byteLength);
  const n = row.times.byteLength / 4;
  const dates: string[] = new Array(n);
  for (let i = 0; i < n; i += 1) dates[i] = isoMinuteUtc(view.getInt32(i * 4, true) * 60_000);

  return {
    ticker: row.ticker,
    dates,
    high: toFloat32(row.high),
    low: toFloat32(row.low),
    close: toFloat32(row.close),
    volume: row.volume ? toFloat32(row.volume) : null,
    open: row.open ? toFloat32(row.open) : null,
  };
}
