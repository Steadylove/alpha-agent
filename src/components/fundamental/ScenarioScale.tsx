import type { FundamentalHorizon } from "@/lib/fundamental/types";
import { fundamentalMoney as money } from "./format";
import { scenarioScale } from "./readout";
import s from "./fundamental.module.css";

export function ScenarioScale({ value, currency, price }: { value: FundamentalHorizon; currency: string; price: number | null }) {
  const scale = scenarioScale(value, price);
  if (!scale) return <p className={s.muted}>价格刻度暂不可用。</p>;
  return <figure className={s.scenario} aria-label={`${value.months}M 情景价格对照`}>
    <figcaption>情景价格对照 <span>共用刻度 · 非价格路径</span></figcaption>
    <dl className={s.scenarioRows}>
      {scale.markers.map(marker => <div className={s.scenarioRow} key={marker.key}>
        <dt>{marker.label}</dt>
        <dd className={s.scenarioTrack} aria-hidden="true">
          <span className={s.scenarioBand} style={{ left: `${scale.rangeStart}%`, width: `${scale.rangeWidth}%` }} />
          <span className={`${s.scenarioMarker} ${marker.key === "quote" ? s.quoteMarker : marker.key === "base" ? s.baseMarker : ""}`} style={{ left: `${marker.position}%` }} />
        </dd>
        <dd className={s.scenarioValue}>{money(marker.value, currency)}</dd>
      </div>)}
    </dl>
    {!scale.markers.some(marker => marker.key === "quote") && <p className={s.muted}>未保存有效报价，图中仅展示情景价格。</p>}
  </figure>;
}
