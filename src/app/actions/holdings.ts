"use server";

import { createClient as createSupabaseClient } from "@supabase/supabase-js";

function getAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url) throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL");
  if (!key) throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  return createSupabaseClient(url, key);
}

function normalizeWatchlistKey(raw: string): string {
  const input = (raw ?? "").trim();
  const upper = input.toUpperCase();
  if (!upper) return "";

  // Allow canonical reserved keys exactly.
  if (
    upper === "SENTINEL" ||
    upper === "LAUNCH_LEADERS" ||
    upper === "HIGH_VELOCITY_MULTIPLIERS" ||
    upper === "SLOW_BURNERS"
  ) {
    return upper;
  }

  // If it's already a canonical custom key, keep it (idempotent).
  if (/^CUSTOM_[A-Z0-9_]{1,44}$/.test(upper)) {
    return upper;
  }

  // Custom keys must live under CUSTOM_ namespace to satisfy DB constraint.
  const slugBase = upper.replace(/[^A-Z0-9]+/g, "_").replace(/_+/g, "_").replace(/^_+|_+$/g, "");
  if (!slugBase) return "";

  const slug = slugBase.slice(0, 44); // DB: ^CUSTOM_[A-Z0-9_]{1,44}$
  return `CUSTOM_${slug}`;
}

type HoldingRow = {
  symbol: string;
  is_held: boolean | null;
  price_in: string | number | null;
};

type HoldingsMap = Record<string, { held: boolean; priceIn: number | null }>;

type WatchlistIdRow = { id: string };
type WatchlistSymbolRow = { symbol: string; sort_order: number | null; is_active: boolean };

type WatchlistSymbolRowWithId = { id: string; symbol: string; sort_order: number | null; is_active: boolean };

export async function getHoldingsMap(ownerUserId: string): Promise<HoldingsMap> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  const supabase = getAdmin();

  const { data, error } = await supabase
    .from("holdings")
    .select("symbol, is_held, price_in")
    .eq("owner_user_id", ownerUserId)
    .order("symbol", { ascending: true });

  if (error) throw new Error(error.message);

  const out: HoldingsMap = {};
  for (const row of (data ?? []) as HoldingRow[]) {
    out[row.symbol] = {
      held: Boolean(row.is_held),
      priceIn: row.price_in == null ? null : Number(row.price_in),
    };
  }
  return out;
}

export async function setHeld(ownerUserId: string, symbol: string, held: boolean): Promise<void> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  if (!symbol) throw new Error("Missing symbol");

  const supabase = getAdmin();

  const { error } = await supabase
    .from("holdings")
    .upsert(
      { owner_user_id: ownerUserId, symbol, is_held: Boolean(held) },
      { onConflict: "owner_user_id,symbol" }
    );

  if (error) throw new Error(error.message);
}

export async function setPriceIn(ownerUserId: string, symbol: string, priceIn: number): Promise<void> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  if (!symbol) throw new Error("Missing symbol");
  const next = Number(priceIn);
  if (!Number.isFinite(next)) throw new Error("Invalid priceIn");

  const supabase = getAdmin();

  const { error } = await supabase
    .from("holdings")
    .upsert(
      { owner_user_id: ownerUserId, symbol, price_in: next },
      { onConflict: "owner_user_id,symbol" }
    );

  if (error) throw new Error(error.message);
}

export async function clearPriceIn(ownerUserId: string, symbol: string): Promise<void> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  if (!symbol) throw new Error("Missing symbol");

  const supabase = getAdmin();

  const { error } = await supabase
    .from("holdings")
    .upsert(
      { owner_user_id: ownerUserId, symbol, price_in: null },
      { onConflict: "owner_user_id,symbol" }
    );

  if (error) throw new Error(error.message);
}

export async function getWatchlistSymbols(ownerUserId: string, watchlistKey: string): Promise<string[]> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  const key = normalizeWatchlistKey(watchlistKey);
  if (!key) throw new Error("Missing watchlistKey");

  const supabase = getAdmin();

  const { data: wlData, error: wlError } = await supabase
    .from("watchlists")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("key", key)
    .limit(1);

  if (wlError) throw new Error(wlError.message);

  const watchlistId = (wlData as WatchlistIdRow[] | null)?.[0]?.id;
  if (!watchlistId) return [];

  const { data, error } = await supabase
    .from("watchlist_symbols")
    .select("symbol, sort_order, is_active")
    .eq("watchlist_id", watchlistId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("symbol", { ascending: true });

  if (error) throw new Error(error.message);

  return ((data ?? []) as WatchlistSymbolRow[]).map((r) => r.symbol);
}

// Add symbol to a watchlist (idempotent). Reactivates if previously inactive.
export async function addWatchlistSymbol(
  ownerUserId: string,
  watchlistKey: string,
  symbol: string
): Promise<void> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  if (!watchlistKey) throw new Error("Missing watchlistKey");
  const key = normalizeWatchlistKey(watchlistKey);
  if (!key) throw new Error("Missing watchlistKey");
  const nextSymbol = (symbol ?? "").trim().toUpperCase();
  if (!nextSymbol) throw new Error("Missing symbol");

  const supabase = getAdmin();

  const { data: wlData, error: wlError } = await supabase
    .from("watchlists")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("key", key)
    .limit(1);

  if (wlError) throw new Error(wlError.message);

  const watchlistId = (wlData as WatchlistIdRow[] | null)?.[0]?.id;
  if (!watchlistId) throw new Error("WATCHLIST_NOT_FOUND");

  const { data: existing, error: existingError } = await supabase
    .from("watchlist_symbols")
    .select("id")
    .eq("watchlist_id", watchlistId)
    .eq("symbol", nextSymbol)
    .limit(1);

  if (existingError) throw new Error(existingError.message);

  if ((existing ?? []).length > 0) {
    const { error: updError } = await supabase
      .from("watchlist_symbols")
      .update({ is_active: true })
      .eq("watchlist_id", watchlistId)
      .eq("symbol", nextSymbol);

    if (updError) throw new Error(updError.message);
    return;
  }

  const { data: maxData, error: maxError } = await supabase
    .from("watchlist_symbols")
    .select("sort_order")
    .eq("watchlist_id", watchlistId)
    .order("sort_order", { ascending: false, nullsFirst: false })
    .limit(1);

  if (maxError) throw new Error(maxError.message);

  const maxSort = (maxData as WatchlistSymbolRow[] | null)?.[0]?.sort_order;
  const nextSort = (typeof maxSort === "number" ? maxSort : 0) + 10;

  const { error } = await supabase
    .from("watchlist_symbols")
    .insert({
      watchlist_id: watchlistId,
      symbol: nextSymbol,
      sort_order: nextSort,
      is_active: true,
    });

  if (error) throw new Error(error.message);
}

// Remove symbol from a watchlist (idempotent). Deactivates if present.
export async function removeWatchlistSymbol(
  ownerUserId: string,
  watchlistKey: string,
  symbol: string
): Promise<void> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  if (!watchlistKey) throw new Error("Missing watchlistKey");

  const key = normalizeWatchlistKey(watchlistKey);
  if (!key) throw new Error("Missing watchlistKey");

  const nextSymbol = (symbol ?? "").trim().toUpperCase();
  if (!nextSymbol) throw new Error("Missing symbol");

  const supabase = getAdmin();

  const watchlistId = await getWatchlistIdOrNull(ownerUserId, key);
  if (!watchlistId) throw new Error("WATCHLIST_NOT_FOUND");

  const { error } = await supabase
    .from("watchlist_symbols")
    .update({ is_active: false })
    .eq("watchlist_id", watchlistId)
    .eq("symbol", nextSymbol);

  if (error) throw new Error(error.message);
}

// Create a watchlist row if it does not exist for the given user/key.
export async function createWatchlist(
  ownerUserId: string,
  watchlistKey: string
): Promise<{ key: string; title: string }> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  if (!watchlistKey) throw new Error("Missing watchlistKey");

  const key = normalizeWatchlistKey(watchlistKey);
  if (!key) throw new Error("Missing watchlistKey");
  const title = (watchlistKey ?? "").trim() || key;

  const supabase = getAdmin();

  const { data: existing, error: exErr } = await supabase
    .from("watchlists")
    .select("id, title")
    .eq("owner_user_id", ownerUserId)
    .eq("key", key)
    .limit(1);

  if (exErr) throw new Error(exErr.message);
  if ((existing ?? []).length > 0) {
    const existingTitle = (existing as any[])[0]?.title;
    return { key, title: existingTitle ?? title };
  }

  // Insert minimal fields; rely on DB defaults for any other columns.
  const { error: insErr } = await supabase.from("watchlists").insert({
    owner_user_id: ownerUserId,
    key,
    title: title,
    is_active: true,
  });
  if (insErr) throw new Error(insErr.message);
  return { key, title };
}

const RESERVED_WATCHLIST_KEYS = new Set([
  "SENTINEL",
  "LAUNCH_LEADERS",
  "HIGH_VELOCITY_MULTIPLIERS",
  "SLOW_BURNERS",
]);

export async function softDeleteWatchlist(ownerUserId: string, watchlistKey: string): Promise<void> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  if (!watchlistKey) throw new Error("Missing watchlistKey");

  const key = normalizeWatchlistKey(watchlistKey);
  if (!key) throw new Error("Missing watchlistKey");

  if (RESERVED_WATCHLIST_KEYS.has(key)) {
    throw new Error("CANNOT_DELETE_RESERVED_WATCHLIST");
  }

  const supabase = getAdmin();

  const { data: wlUpd, error: wlErr } = await supabase
    .from("watchlists")
    .update({ is_active: false })
    .eq("owner_user_id", ownerUserId)
    .eq("key", key)
    .select("id")
    .limit(1);

  if (wlErr) throw new Error(wlErr.message);

  const watchlistId = (wlUpd as WatchlistIdRow[] | null)?.[0]?.id;
  if (!watchlistId) throw new Error("WATCHLIST_NOT_FOUND");

  const { data: symUpd, error: symErr } = await supabase
    .from("watchlist_symbols")
    .update({ is_active: false })
    .eq("watchlist_id", watchlistId)
    .select("id");

  if (symErr) throw new Error(symErr.message);

  // If there were no symbols, symUpd may be empty; that's OK.
  void symUpd;
}

async function getWatchlistIdOrNull(ownerUserId: string, watchlistKey: string): Promise<string | null> {
  const key = normalizeWatchlistKey(watchlistKey);
  if (!key) return null;

  const supabase = getAdmin();

  const { data: wlData, error: wlError } = await supabase
    .from("watchlists")
    .select("id")
    .eq("owner_user_id", ownerUserId)
    .eq("key", key)
    .limit(1);

  if (wlError) throw new Error(wlError.message);
  return (wlData as WatchlistIdRow[] | null)?.[0]?.id ?? null;
}

async function getActiveWatchlistSymbolRows(watchlistId: string): Promise<WatchlistSymbolRowWithId[]> {
  const supabase = getAdmin();

  const { data, error } = await supabase
    .from("watchlist_symbols")
    .select("id, symbol, sort_order, is_active")
    .eq("watchlist_id", watchlistId)
    .eq("is_active", true)
    .order("sort_order", { ascending: true, nullsFirst: false })
    .order("symbol", { ascending: true });

  if (error) throw new Error(error.message);
  return (data ?? []) as WatchlistSymbolRowWithId[];
}

async function normalizeWatchlistSortOrderIfNeeded(watchlistId: string): Promise<void> {
  const rows = await getActiveWatchlistSymbolRows(watchlistId);
  if (rows.length === 0) return;

  const needsNormalize = rows.some((r) => r.sort_order == null);
  if (!needsNormalize) return;

  const supabase = getAdmin();
  for (let i = 0; i < rows.length; i++) {
    const nextSort = (i + 1) * 10;
    const { error: updError } = await supabase
      .from("watchlist_symbols")
      .update({ sort_order: nextSort })
      .eq("id", rows[i].id);

    if (updError) throw new Error(updError.message);
  }
}

// Adjacent-swap reorder for a watchlist symbol. Used by v1 UP/DN controls.
export async function reorderWatchlistSymbol(
  ownerUserId: string,
  watchlistKey: string,
  symbol: string,
  direction: "up" | "down"
): Promise<void> {
  if (!ownerUserId) throw new Error("Missing ownerUserId");
  if (!watchlistKey) throw new Error("Missing watchlistKey");

  const key = normalizeWatchlistKey(watchlistKey);
  if (!key) throw new Error("Missing watchlistKey");

  const nextSymbol = (symbol ?? "").trim().toUpperCase();
  if (!nextSymbol) throw new Error("Missing symbol");

  const watchlistId = await getWatchlistIdOrNull(ownerUserId, key);
  if (!watchlistId) throw new Error("WATCHLIST_NOT_FOUND");

  // Ensure numeric sort_order before swapping.
  await normalizeWatchlistSortOrderIfNeeded(watchlistId);

  const rows = await getActiveWatchlistSymbolRows(watchlistId);
  const idx = rows.findIndex((r) => r.symbol === nextSymbol);
  if (idx < 0) return;

  const swapIdx = direction === "up" ? idx - 1 : idx + 1;
  if (swapIdx < 0 || swapIdx >= rows.length) return;

  const a = rows[idx];
  const b = rows[swapIdx];

  const aSort = typeof a.sort_order === "number" ? a.sort_order : (idx + 1) * 10;
  const bSort = typeof b.sort_order === "number" ? b.sort_order : (swapIdx + 1) * 10;

  const supabase = getAdmin();

  // Swap sort_order between the two rows (minimal writes).
  const { error: errA } = await supabase.from("watchlist_symbols").update({ sort_order: bSort }).eq("id", a.id);
  if (errA) throw new Error(errA.message);

  const { error: errB } = await supabase.from("watchlist_symbols").update({ sort_order: aSort }).eq("id", b.id);
  if (errB) throw new Error(errB.message);
}