export function getLocalPriceIn(symbol: string): number | null {
  const s = symbol.trim().toUpperCase();
  if (!s || s === "—") return null;

  // Temporary local map (until holdings table is wired)
  const map: Record<string, number> = {
    SOUN: 11.29,
    AAPL: 189.5,
  };

  return map[s] ?? null;
}