"use client";

import { useMemo, useSyncExternalStore } from "react";
import { realtimeState, type RealtimeState } from "@/lib/realtime/realtimeState";

export function useRealtimeState<T>(selector: (s: RealtimeState) => T): T {
  // IMPORTANT:
  // - useSyncExternalStore snapshots must be referentially stable between emits.
  // - do NOT return selector(...) from getSnapshot, because selectors often allocate new objects.
  const snapshot = useSyncExternalStore(
    realtimeState.subscribe,
    realtimeState.getState,
    realtimeState.getState
  );

  // Apply selector after we have the stable snapshot.
  // (Memo is optional; kept for clarity.)
  return useMemo(() => selector(snapshot), [snapshot, selector]);
}