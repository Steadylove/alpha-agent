/** 仅规范展示，不改已冻结快照中的维度标识或分数。 */
export function qualityDimensionLabel(name: string): string {
  return name === "风险" ? "止损评分" : name;
}

export function qualityReasonText(reason: string): string {
  return reason.replace(/参考初始风险 ([\d.]+)%；未假设上涨目标/g,
    "距参考止损 $1%；止损距离越小，此项得分越高");
}
