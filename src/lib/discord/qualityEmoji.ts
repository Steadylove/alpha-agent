import { CARD_INK } from "./cardTheme";

export type QualityMood = "excellent" | "good" | "fair" | "weak" | "missing";

export function qualityBadge(points: number, available: number) {
  if (available !== 100) return { mood:"missing" as const, label:"资料未齐", emoji:"⏳", color:CARD_INK.muted };
  if (points >= 80) return { mood:"excellent" as const, label:"优秀", emoji:"🤩", color:CARD_INK.buy };
  if (points >= 65) return { mood:"good" as const, label:"良好", emoji:"🙂", color:CARD_INK.buy };
  if (points >= 50) return { mood:"fair" as const, label:"一般", emoji:"😐", color:CARD_INK.take };
  return { mood:"weak" as const, label:"偏弱", emoji:"😟", color:CARD_INK.stop };
}

/** 内置矢量表情，PNG/SVG 同源，不依赖服务器 emoji 字体或远程图片。 */
export function qualityEmojiSvg(mood: QualityMood): string {
  const ink = "#67441F";
  let face: string;
  if (mood === "missing") {
    face = '<path d="M19 10H45M19 54H45" stroke="#B6C3CD" stroke-width="5" stroke-linecap="round"/>' +
      '<path d="M22 13H42V20L35 31L42 43V51H22V43L29 31L22 20Z" fill="#314452" stroke="#8C9EAE" stroke-width="2"/>' +
      '<path d="M26 18H38L32 27ZM26 46L32 36L38 46Z" fill="#EBC47F"/>';
  } else {
    const eyes = mood === "excellent"
      ? '<path d="M21 15L23.5 21L30 21.5L25 26L26.5 32L21 28.5L15.5 32L17 26L12 21.5L18.5 21ZM43 15L45.5 21L52 21.5L47 26L48.5 32L43 28.5L37.5 32L39 26L34 21.5L40.5 21Z"/>'
      : '<ellipse cx="22" cy="26" rx="3" ry="4"/><ellipse cx="42" cy="26" rx="3" ry="4"/>';
    const mouth = mood === "excellent" ? '<path d="M19 37Q32 41 45 37Q43 52 32 52Q21 52 19 37Z"/>' :
      mood === "good" ? `<path d="M20 39Q32 52 44 39" fill="none" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>` :
      mood === "fair" ? `<path d="M22 42H42" stroke="${ink}" stroke-width="3.5" stroke-linecap="round"/>` :
      `<path d="M22 45Q32 34 42 45M16 19L25 16M39 16L48 19" fill="none" stroke="${ink}" stroke-width="3" stroke-linecap="round"/>`;
    face = `<circle cx="32" cy="32" r="29" fill="#F5C65D"/><circle cx="23" cy="16" r="12" fill="#FFE29A" opacity=".28"/><g fill="${ink}">${eyes}${mouth}</g>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">${face}</svg>`;
}
