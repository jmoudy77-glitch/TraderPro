"use client";

type ToggleKey = "rsi" | "macd" | "sma50" | "sma200";

function Toggle({
  active,
  label,
  onClick,
}: {
  active: boolean;
  label: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={[
        "rounded-md border px-2 py-1 text-[11px]",
        active
          ? "border-neutral-600 bg-neutral-800 text-neutral-100"
          : "border-neutral-800 bg-neutral-950 text-neutral-400 hover:text-neutral-200",
      ].join(" ")}
    >
      {label}
    </button>
  );
}

export default function IndicatorToggles({
  indicators,
  onToggle,
}: {
  indicators: Record<ToggleKey, boolean>;
  onToggle: (key: ToggleKey) => void;
}) {
  return (
    <div className="flex items-center gap-1">
      <Toggle
        active={indicators.rsi}
        label="RSI"
        onClick={() => onToggle("rsi")}
      />
      <Toggle
        active={indicators.macd}
        label="MACD"
        onClick={() => onToggle("macd")}
      />
      <div className="mx-1 h-4 w-px bg-neutral-800" />
      <Toggle
        active={indicators.sma50}
        label="SMA50"
        onClick={() => onToggle("sma50")}
      />
      <Toggle
        active={indicators.sma200}
        label="SMA200"
        onClick={() => onToggle("sma200")}
      />
    </div>
  );
}