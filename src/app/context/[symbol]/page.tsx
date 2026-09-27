import { SymbolContext } from "@/components/context/SymbolContext";
import { getSymbolContext } from "@/lib/context/store";

export const dynamic = "force-dynamic";
export const metadata = {
  title: "Event × Flow × Trend · Context",
  description: "按留档日期并列观察现实事件、异常期权流与系统信号。",
};

export default async function ContextPage({ params, searchParams }: {
  params: Promise<{ symbol: string }>;
  searchParams: Promise<{ date?: string }>;
}) {
  const [{ symbol: rawSymbol }, { date }] = await Promise.all([params, searchParams]);
  const symbol = rawSymbol.trim().toUpperCase();
  const context = await getSymbolContext(symbol, date);
  return <SymbolContext symbol={symbol} date={date} context={context} />;
}
