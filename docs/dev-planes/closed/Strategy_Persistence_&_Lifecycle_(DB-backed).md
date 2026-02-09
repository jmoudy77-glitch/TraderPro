

# Dev Plane — Strategy Persistence & Lifecycle (DB-backed)

**Date:** 2026-02-07  
**Primary Focus:** Introduce durable Strategy persistence to support Objective binding, session-bound ratification, and lifecycle transitions.  
**Related Canon:** `docs/canon/TRADERPRO_CANONICAL_SPEC.md`  
**Related System Status:** `docs/ops/TRADERPRO_SYSTEM_STATUS_MASTER.md`

---

## Assistant Operating Rules (Active)

0. **Primary responsibility**  
The assistant’s primary responsibility is to preserve shared context and user intent over time by enforcing patience and accuracy as prime execution directives.

0.a **Grounding discipline**  
When grounding is required, the assistant must reference the correct document based on the question being answered:
- **Canonical Spec & Operating Manual** is used to ground:
  - system intent
  - architectural direction
  - plane definitions
  - invariants and non-negotiables
- **System Status Master** is used to ground:
  - what is currently live
  - what is incomplete, degraded, or inactive
  - which planes or features are available today
  - sequencing constraints (Now → Ship roadmap)
- **Dev Plane Notes** are used to ground:
  - current scope
  - active tasks and exit criteria
  - temporary assumptions and decisions

The assistant must not answer questions about current behavior using Canon alone, nor answer questions about directional intent using System Status alone.

0.b **Edit tool target verification (oboe)**  
- The assistant must not issue an edit unless the exact file-path header line has been provided and explicitly confirmed.
- After any `oboe.edit_file` operation, the change must be treated as unverified until user confirmation.
- Any ambiguity requires re-anchoring on the file-path header.

0.c **Edit confirmation scope**  
A confirmed file-path header applies only to the immediately following edit or tightly continuous edits. Re-confirmation is required after any context shift.

1. **Stay in the current dev plane**  
2. **Surface canon misalignment**  
3. **No pushback after decision**  
4. **No silent reframing**  
5. **Confirm before high-impact action**  
6. **No unsolicited optimization or cleanup**  
7. **Treat the current Note as authoritative**  
8. **Do not guess**  
9. **Dev Plane update required after functional change**  
10. **Failure modes are captured immediately**  
11. **Dev Plane closure discipline**  
12. **Checklist-first execution**

---

## Objective

Introduce a durable, DB-backed Strategy model that supports:
- binding a Strategy to an ACTIVE Objective
- explicit session-bound ratification
- Strategy lifecycle transitions (draft → active → expired)
- downstream consumption by UI, AI, and Monitoring planes

This plane establishes **data truth and lifecycle semantics only**.  
It does **not** introduce execution, automation, or AI behavior.

---

## Scope

### In Scope
- Strategy persistence in the Durable Data Plane
- Objective → Strategy binding (authoritative)
- Session-bound ratification fields
- Strategy lifecycle states and transitions
- Minimal API surface to load/save Strategy and ratification state
- Auditability (who/when/what was ratified)

### Out of Scope
- Trade execution or order lifecycle
- Strategy automation or monitoring behavior
- AI strategy generation or critique logic
- UI affordance changes beyond data wiring
- Authentication redesign or permission models
- Historical backfill or migration of legacy strategies

---

## Decisions (Locked)

- Strategy governance binds to `public.objective_frames` (not `public.objectives`) for Objective truth.
- Strategy session authority is ET; canonical session key is ET date (`YYYY-MM-DD`) per Canon §5 / §5.a.
- Activation is one-step (Activate = ratify + activate) and remains session-scoped (no implicit carryover).
- Ratification authority is stored at the Strategy row level (not only in events).

---

## Execution Checklist

### Schema & Binding
- [x] Confirm Strategy anchor tables exist: `public.strategies`, `public.strategy_versions`, `public.strategy_version_events`
- [x] Confirm Objective anchor is `public.objective_frames`
- [x] Add Objective binding: `strategies.objective_frame_id`
- [x] Add ratification fields at Strategy level
- [x] Add activation fields at Strategy level
- [x] Add integrity constraint enforcing Objective alignment when ACTIVE

### Session Semantics (ET)
- [x] Canonical session key is ET date (`ratified_session_key_et`)
- [x] `trade_date` is display-only
- [x] Define EXPIRED rule based on session mismatch

### Lifecycle & Invariants
- [x] Lifecycle statuses: `DRAFT / ACTIVE / EXPIRED / ARCHIVED`
- [x] Enforce single ACTIVE Strategy per user per ET session (DB index)
- [x] Define re-activation behavior (overwrite ratification + emit event)

### API Surface (Minimal)
- [x] GET `/api/strategy/frame`
- [x] POST `/api/strategy/draft`
- [x] POST `/api/strategy/activate`

### Integration Readiness
- [x] StrategyPanel wired to Strategy frame
- [x] Eligibility computed from persisted truth
- [x] System Status updated
- [x] State of Truth updated

---

## State of Truth (As of 2026-02-07)

- Strategy governance semantics are defined in Canon
- Strategy persistence exists and includes Objective binding + session ratification
- UI eligibility enforcement consumes persisted Objective + Strategy truth
- Objective persistence exists and is authoritative
- Execution and AI planes remain gated

---

## Canonical Constraints (Non-Negotiable)

- Strategies are Objective-bound
- Strategies are session-scoped and expire at session end
- Ratification is explicit and user-initiated
- No Strategy carries forward implicitly across sessions
- Persistence establishes truth; other planes may consume but not override it

---

## Exit Status

**CLOSED — COMPLETE**

This Dev Plane is closed with all exit criteria satisfied and its outcomes absorbed into:
- Canon (invariants and semantics)
- System Status (what is live vs gated)

Historical context is retained here for auditability.