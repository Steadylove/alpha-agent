/**
 * RPS 多周期因子 · 防追高三大战法（温和版）
 *
 * - 战法一：短周期塌陷法
 * - 战法二：绝对上限封印法
 * - 战法三：多头加速穿越法
 */

export type Playbook = "PULLBACK" | "CLIMAX_FILTER" | "EARLY_ACCELERATION";

export type RpsQuad = {
  r20: number;
  r50: number;
  r120: number;
  r250: number;
};

export type PlaybookMeta = {
  key: Playbook;
  name: string;
  englishName: string;
  slogan: string;
  stage: string;
  emoji: string;
  color: number;
  rule: string;
};

export const PLAYBOOK_META: Record<Playbook, PlaybookMeta> = {
  PULLBACK: {
    key: "PULLBACK",
    name: "短周期塌陷法（温和版）",
    englishName: "The Pullback / Re-accumulation",
    slogan: "长期强势 + 短期冷却，买点更舒适",
    stage: "Stage 2 Mid · 重新蓄势期",
    emoji: "🟠",
    color: 0xf59e0b,
    rule: "RPS250/120/50≥80 · 50≤RPS20≤80 · RPS20<RPS50",
  },
  CLIMAX_FILTER: {
    key: "CLIMAX_FILTER",
    name: "绝对上限封印法（温和版）",
    englishName: "The Climax Filter / Anti-Bubble",
    slogan: "拒绝最狂热的，拥抱二线强势",
    stage: "Stage 2 Mature · 防范 Stage 3 见顶高潮",
    emoji: "🔵",
    color: 0x3b82f6,
    rule: "全周期<97 · 250/120∈[80,97) · 50∈[75,97) · 20∈[70,97)",
  },
  EARLY_ACCELERATION: {
    key: "EARLY_ACCELERATION",
    name: "多头加速穿越法（温和版）",
    englishName: "The Early Stage Acceleration",
    slogan: "动能从底部共振向上，更早捕捉走强",
    stage: "Stage 1 → Stage 2 · 初期突破",
    emoji: "🟢",
    color: 0x22c55e,
    rule: "RPS250>60 · RPS120>80 · RPS50>80 · RPS20>85 · 20>50>120>250",
  },
};

export const PLAYBOOKS: Playbook[] = [
  "PULLBACK",
  "CLIMAX_FILTER",
  "EARLY_ACCELERATION",
];

/** 每日推荐强势池：四周期 RPS 均 > 该值（与战法池分开推送） */
export const BASE_RPS_THRESHOLD = 80;

export function passesBaseRps(
  rps: RpsQuad,
  threshold = BASE_RPS_THRESHOLD,
): boolean {
  return (
    rps.r20 > threshold &&
    rps.r50 > threshold &&
    rps.r120 > threshold &&
    rps.r250 > threshold
  );
}

/** 战法一：长中期 ≥80，短期塌陷到 50–80，且 RPS20 < RPS50 */
export function matchesPullback(rps: RpsQuad): boolean {
  return (
    rps.r250 >= 80 &&
    rps.r120 >= 80 &&
    rps.r50 >= 80 &&
    rps.r20 >= 50 &&
    rps.r20 <= 80 &&
    rps.r20 < rps.r50
  );
}

/** 战法二：全周期 <97，落在稳健非狂热区间 */
export function matchesClimaxFilter(rps: RpsQuad): boolean {
  return (
    rps.r20 < 97 &&
    rps.r50 < 97 &&
    rps.r120 < 97 &&
    rps.r250 < 97 &&
    rps.r250 >= 80 &&
    rps.r120 >= 80 &&
    rps.r50 >= 75 &&
    rps.r20 >= 70
  );
}

/** 战法三：脱离底部 + 短线点火 + 严格四周期多头排列 */
export function matchesEarlyAcceleration(rps: RpsQuad): boolean {
  return (
    rps.r250 > 60 &&
    rps.r120 > 80 &&
    rps.r50 > 80 &&
    rps.r20 > 85 &&
    rps.r20 > rps.r50 &&
    rps.r50 > rps.r120 &&
    rps.r120 > rps.r250
  );
}

export function matchesPlaybook(playbook: Playbook, rps: RpsQuad): boolean {
  if (playbook === "PULLBACK") return matchesPullback(rps);
  if (playbook === "CLIMAX_FILTER") return matchesClimaxFilter(rps);
  return matchesEarlyAcceleration(rps);
}

export function scorePlaybook(playbook: Playbook, rps: RpsQuad): number {
  if (playbook === "PULLBACK") return (rps.r250 + rps.r120 + rps.r50) / 3;
  if (playbook === "CLIMAX_FILTER") return (rps.r120 + rps.r50 + rps.r20) / 3;
  return (rps.r20 + rps.r50 + rps.r120 + rps.r250) / 4;
}
