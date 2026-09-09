export type PoolRevision = { id: string; effectiveAt: string; members: string[] };

/** CSV 时间戳为 UTC 的 K 线起点。保存后新开始的 K 线才使用新名单。 */
export function poolAt(revisions: readonly PoolRevision[], barDate: string): readonly string[] {
  const at = Date.parse(`${barDate.replace(/Z$/, "")}Z`);
  let members: readonly string[] = [];
  for (const revision of revisions) {
    if (!revision.effectiveAt || Date.parse(revision.effectiveAt) <= at) members = revision.members;
  }
  return members;
}

export function poolRevisionsOf(raw: unknown): PoolRevision[] | undefined {
  if (raw == null) return undefined;
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("股票池版本记录无效");
  let last = -Infinity;
  const ids = new Set<string>();
  return raw.map((value, i) => {
    const r = value as PoolRevision;
    const time = r?.effectiveAt === "" && i === 0 ? -Infinity : Date.parse(r?.effectiveAt);
    if (!r || typeof r.id !== "string" || !r.id || ids.has(r.id) || Number.isNaN(time) || time < last ||
      !Array.isArray(r.members) || r.members.some((m) => typeof m !== "string" || !/^[A-Z][A-Z0-9.-]{0,9}$/.test(m))) {
      throw new Error("股票池版本记录无效");
    }
    last = time;
    ids.add(r.id);
    return { id: r.id, effectiveAt: r.effectiveAt, members: [...new Set(r.members)].sort() };
  });
}
