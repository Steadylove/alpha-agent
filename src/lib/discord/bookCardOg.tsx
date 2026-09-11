import { cashBookLayout } from "./bookCardLayout";
import type { CashBookView } from "./bookCopy";
import { renderReportCardOgPng } from "./reportCardOg";

export function renderCashBookOgPng(input: CashBookView): Promise<Buffer> {
  return renderReportCardOgPng(cashBookLayout(input));
}
