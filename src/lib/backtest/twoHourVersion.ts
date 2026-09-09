/** 旧版每天三根的 2H 已作废。此版本同时标识行情切法和对应的账本结果。 */
export const TWO_HOUR_VERSION = "2h-rth-4bars-v1";

export function usableTwoHourResult(tf: string, version: string | undefined): boolean {
  return tf !== "2h" || version === TWO_HOUR_VERSION;
}
