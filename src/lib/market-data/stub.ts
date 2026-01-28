import type { Candle } from "./types";

type StubArgs = {
  symbol: string;
  resolution: string;
  range: string;

  /**
   * Optional overrides for generating a deterministic window.
   * If both startMs and endMs are provided, candles are generated from start→end.
   * If only endMs is provided, the generator keeps the existing v1 count behavior and ends at endMs.
   */
  startMs?: number;
  endMs?: number;
};

function stepSecondsForResolution(resolution: string): number {
  // Keep in sync with the candles API expectations.
  switch (resolution) {
    case "1m":
      return 60;
    case "5m":
      return 5 * 60;
    case "15m":
      return 15 * 60;
    case "1h":
      return 60 * 60;
    case "4h":
      return 4 * 60 * 60;
    case "1d":
      return 24 * 60 * 60;
    default:
      return 5 * 60;
  }
}

function durationSecondsForRange(range: string): number {
  switch (range) {
    case "1D":
      return 24 * 60 * 60;
    case "5D":
      return 5 * 24 * 60 * 60;
    case "1M":
      return 30 * 24 * 60 * 60;
    case "3M":
      return 90 * 24 * 60 * 60;
    case "6M":
      return 180 * 24 * 60 * 60;
    default:
      return 24 * 60 * 60;
  }
}

function seedFromString(input: string): number {
  let seed = 0;
  for (let i = 0; i < input.length; i++) {
    seed = (seed * 31 + input.charCodeAt(i)) >>> 0;
  }
  return seed >>> 0;
}

function makeRand(seedInit: number): () => number {
  let seed = seedInit >>> 0;
  return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

export function generateStubCandles({ symbol, resolution, range, startMs, endMs }: StubArgs): Candle[] {
  const stepSeconds = stepSecondsForResolution(resolution);
  const durationSeconds = durationSecondsForRange(range);
  const stepMs = stepSeconds * 1000;

  // Keep v1 behavior for 1D: 78 intraday candles when using intraday resolutions.
  // For daily resolution, emit a small, clean daily series.
  const defaultCount =
    resolution === "1d"
      ? Math.max(2, Math.ceil(durationSeconds / stepSeconds) + 40)
      : range === "1D"
        ? 78
        : 100;

  const align = (ms: number) => Math.floor(ms / stepMs) * stepMs;

  const endAlignedMs = align(endMs ?? Date.now());

  // If a startMs override is provided, generate exactly the window start→end.
  // Otherwise, preserve existing behavior (fixed count ending at end).
  let startAlignedMs: number;
  let count: number;

  if (typeof startMs === "number") {
    startAlignedMs = align(startMs);

    // Ensure start <= end. If not, fall back to a tiny series at end.
    if (startAlignedMs >= endAlignedMs) {
      startAlignedMs = endAlignedMs - stepMs;
    }

    // Inclusive endpoints (e.g. 09:30, 09:35, ..., 16:00)
    count = Math.max(2, Math.floor((endAlignedMs - startAlignedMs) / stepMs) + 1);
  } else {
    count = defaultCount;
    startAlignedMs = endAlignedMs - count * stepMs;
  }

  // Seeded RNG (stable by symbol + resolution + range)
  // Include start/end alignment in the seed so session windows remain deterministic.
  const rand = makeRand(seedFromString(`${symbol}:${resolution}:${range}:${startAlignedMs}:${endAlignedMs}`));

  let price = 100 + rand() * 20;
  const candles: Candle[] = [];

  for (let i = 0; i < count; i++) {
    // Small drift; slightly smaller for daily candles so it doesn't explode.
    const driftScale = resolution === "1d" ? 0.25 : 0.5;
    const delta = (rand() - 0.5) * driftScale;

    const open = price;
    const close = price * (1 + delta / 100);

    candles.push({
      time: Math.floor((startAlignedMs + i * stepMs) / 1000),
      open,
      high: Math.max(open, close),
      low: Math.min(open, close),
      close,
    });

    price = close;
  }

  return candles;
}