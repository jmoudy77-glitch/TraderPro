// src/lib/realtime/useRealtimeState.ts
import { useSyncExternalStore } from "react";
import { realtimeState, RealtimeState } from "@/lib/realtime/realtimeState";

export function useRealtimeState<T>(selector: (s: RealtimeState) => T): T {
  return useSyncExternalStore(
    realtimeState.subscribe,
    () => selector(realtimeState.getState()),
    () => selector(realtimeState.getState())
  );
}