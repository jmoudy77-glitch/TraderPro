

# TraderPro — System Status Master

> **Purpose**  
> This document describes the **current operational reality** of TraderPro.  
> It records what is live, what is authoritative, what is degraded, and what is in transition.  
> It does **not** define intent (see Canon) and does **not** replace Dev Plane Notes.

---

## 0. Status Header

Last updated: 2026-02-07  
Overall system posture: TRANSITIONING  
Primary risk vector: Historical candle routing still stabilizing

---

## 1. Authority Alignment

| Plane | Current Authority | Status | Notes |
|-----|------------------|--------|------|
| Durable Data Plane | Supabase | STABLE | Scheduler-driven |
| Intraday Plane | Fly realtime-ws | STABLE | Alpaca WS primary |
| Cognition Plane | UI + DB | PARTIAL | Notes + Strategy present |
| AI Plane | None | INACTIVE | Plane defined, not active |
| Execution Plane | None | INACTIVE | Engineered-for, gated |
| UI Plane | Next.js App | STABLE | No provider coupling |

---

## 2. Data Flow (As-Is)

Durable candles (1h / 4h / 1D):  
Alpaca REST → Scheduler → Supabase → API → UI

Intraday candles (<1h):  
Alpaca WS → Fly realtime-ws → UI  
↳ REST fallback (server-side only)

Live ticks:  
Alpaca WS → Fly realtime-ws → UI overlay

---

## 3. Endpoint Status Matrix

| Endpoint | Role | Authority | Status |
|--------|-----|----------|--------|
| /api/market/candles/window | Canonical historical hydration | PRIMARY | ACTIVE |
| /api/market/candles | Durable reader/writer | PRIMARY | ACTIVE |
| /api/realtime/health | Realtime service truth | PRIMARY | ACTIVE |
| /api/scheduler/tick | Durable backfill | PRIMARY | ACTIVE |
| /api/realtime/candles/intraday | Legacy | SECONDARY | DEPRECATED |
| /api/market/candles/after-hours | Legacy | SECONDARY | DEPRECATED |

Rule: If the UI is calling something not listed here, that is a bug.

---

## 4. Candle Coverage & Retention Status

| Resolution | Source | Retention Policy | Status |
|-----------|-------|------------------|--------|
| 1m | Fly WS | Session-only | OK |
| 5m | Fly WS | Today + prior | OK |
| 1h | Supabase | ~5 trading days | OK |
| 4h | Supabase | ~1 month | OK |
| 1D | Supabase | ~1 year | OK |

---

## 5. Scheduler Health

Last bootstrap run: <unknown>  
Last maintenance run: <unknown>

Symbol universe:
- Watchlist symbols
- Holdings symbols
- Sentinel symbols

---

## 6. UI Contract Compliance

| Contract | Status | Notes |
|--------|--------|------|
| Range↔Resolution auto-bump | OK | Silent |
| Daily tooltip (date only) | OK | Locked |
| Held charts = holdings only | OK | Enforced |
| Objective panel present | NOT PRESENT | Planned |
| Objective → Strategy linkage | NOT PRESENT | Blocked on Objective |
| Analysis Grid persistence | NOT STARTED | Known gap |

---

## 7. Active Transitions

- Migration to single canonical historical candles endpoint in progress  
  Risk: mixed hydration paths if regression introduced  
  Mitigation: network audit + endpoint matrix

---

## 8. Known Degradations

- Objective panel not yet implemented
- AI Plane defined but not active
- Execution Plane defined but not active

---

## 9. Now → Ship Roadmap (Anti-Refactor Path)

This roadmap exists to guide current development toward a coherent,
shippable system state while minimizing future refactoring.

### NOW (Must be true before advancing)

- Single canonical historical candles endpoint fully adopted
- Legacy candle routes unused by UI
- Scheduler observability sufficient to verify durable coverage
- UI routing clearly separates durable vs intraday hydration

### NEXT (Enables execution + AI safely)

- Objective panel implemented and persisted
- Objective → Strategy linkage enforced
- Strategy ratification gates downstream behavior
- Durable coverage guarantees locked per symbol universe
- Scheduler diagnostics hardened (counts, gaps, timestamps)

### SHIP (Execution-Ready Substrate)

- Durable plane trustworthy without manual inspection
- Cognition plane complete: Objective → Strategy → AAR loop
- Intraday plane failure modes visible and non-fatal
- Execution Plane activatable without changing data paths
- AI Plane activatable without bypassing durable truth

---

## 10. Diagnostic Quick Reference

If charts load but are empty:  
→ Check endpoint matrix  
→ Verify range/resolution normalization  
→ Confirm DB candle coverage

If posture or intel outputs return zeros:  
→ Check candles_daily coverage  
→ Confirm index anchor rows  
→ Do NOT check provider connectivity

---

_End of System Status Master_