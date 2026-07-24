import type { Instrument } from "@/lib/types/market";

const CONSTITUENTS_URL =
  "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";

const GICS_TO_SECTOR: Record<string, string> = {
  "Information Technology": "Technology",
  "Health Care": "Health Care",
  "Financials": "Financials",
  "Consumer Discretionary": "Consumer Discretionary",
  "Communication Services": "Communication Services",
  "Industrials": "Industrials",
  "Consumer Staples": "Consumer Staples",
  "Energy": "Energy",
  "Utilities": "Utilities",
  "Real Estate": "Real Estate",
  "Materials": "Materials",
};

const parseCsvLine = (line: string): string[] => {
  const result: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      result.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  result.push(current);
  return result;
};

export async function fetchSp500Universe(): Promise<Instrument[]> {
  let response: Response;
  try {
    response = await fetch(CONSTITUENTS_URL, { next: { revalidate: 24 * 60 * 60 } });
  } catch {
    return [];
  }

  if (!response.ok) {
    return [];
  }

  const csv = await response.text();
  const lines = csv.trim().split("\n");
  if (lines.length < 2) return [];

  const headers = parseCsvLine(lines[0]).map((h) => h.trim());
  const symbolIdx = headers.indexOf("Symbol");
  const nameIdx = headers.indexOf("Security");
  const sectorIdx = headers.indexOf("GICS Sector");
  const industryIdx = headers.indexOf("GICS Sub-Industry");

  if (symbolIdx < 0 || nameIdx < 0) return [];

  const instruments: Instrument[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const cells = parseCsvLine(line);
    const rawSymbol = cells[symbolIdx]?.trim();
    if (!rawSymbol) continue;
    // 兼容 BRK.B / BF.B 等：Yahoo 用 BRK-B
    const symbol = rawSymbol.replace(".", "-");
    const gicsSector = cells[sectorIdx]?.trim();
    instruments.push({
      symbol,
      name: cells[nameIdx]?.trim() ?? symbol,
      type: "STOCK",
      sector: gicsSector ? GICS_TO_SECTOR[gicsSector] ?? gicsSector : undefined,
      industry: cells[industryIdx]?.trim() || undefined,
    });
  }

  return instruments;
}
