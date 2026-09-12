export const CARD_DISCLAIMER = "仅供信息参考，不构成投资建议";
/** 免责声明跟已有页脚/标题同一行，不再单独加高。 */
export const CARD_DISCLAIMER_HEIGHT = 0;
export const CARD_DISCLAIMER_SIZE = 12;

export function withDisclaimer(text: string): string {
  if (!text) return CARD_DISCLAIMER;
  if (text.includes(CARD_DISCLAIMER)) return text;
  return `${text} · ${CARD_DISCLAIMER}`;
}
