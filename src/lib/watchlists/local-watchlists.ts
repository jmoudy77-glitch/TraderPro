export type WatchlistKey =
  | "SENTINEL"
  | "LAUNCH_LEADERS"
  | "HIGH_VELOCITY_MULTIPLIERS"
  | "SLOW_BURNERS";

export const LOCAL_WATCHLISTS: Record<WatchlistKey, string[]> = {
  SENTINEL: [
    // Index pseudo-mirrors
    "QQQ",
    "ONEQ",

    // Permission leaders
    "PLTR",
    "RKLB",
    "PL",

    // Additional sentinels
    "MSFT",
    "NVDA", // or "AMD" — pick one, not both
    "JPM",
    "XOM",
    "AMZN",
  ],
  
  LAUNCH_LEADERS: ["SOUN", "PLTR", "NVDA"],
  HIGH_VELOCITY_MULTIPLIERS: ["TSLA", "AMD", "META"],
  SLOW_BURNERS: ["AAPL", "MSFT", "GOOGL"],
};