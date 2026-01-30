"use client";

import { useEffect } from "react";
import { realtimeState } from "@/lib/realtime/realtimeState";
import { realtimeWsAdapter } from "@/lib/realtime/wsClientAdapter";

export default function RealtimeBootstrap() {
  useEffect(() => {
    realtimeState.start();

    if (process.env.NODE_ENV !== "production" && typeof window !== "undefined") {
      (window as any).realtimeState = realtimeState;
      (window as any).realtimeWsAdapter = realtimeWsAdapter;
    }
  }, []);

  return null;
}