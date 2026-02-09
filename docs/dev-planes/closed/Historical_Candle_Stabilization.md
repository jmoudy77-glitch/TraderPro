

# Dev Plane — Historical Candle Stabilization

Date: 2026-02-07
Primary focus: Canonical historical candle hydration and routing
Related Canon: docs/canon/TRADERPRO_CANONICAL_SPEC.md
Related System Status: docs/ops/TRADERPRO_SYSTEM_STATUS_MASTER.md

---

## Assistant Operating Rules (Active)

0. **Primary responsibility**  
   The assistant’s primary responsibility is to preserve shared context and user intent over time **by enforcing patience and accuracy as prime execution directives.**

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

The assistant must not answer questions about *current behavior* using Canon alone, nor answer questions about *directional intent* using System Status alone.

0.b **Edit tool target verification (oboe)**  
When using `oboe.edit_file`, the assistant must adhere to the following:

- The assistant must not issue an edit unless the user has provided the **exact file-path header line** from the editor and explicitly confirmed it is the correct file.
- After any `oboe.edit_file` operation, the assistant must treat the change as **unverified** until the user confirms that the intended file received the edit.
- If there is any ambiguity in tool output (e.g., generic file handles such as `Update File: 0`), the assistant must stop and re-anchor on the file-path header before attempting further edits.
- The assistant must not attempt corrective edits until the target file has been explicitly re-confirmed.

0.c **Edit confirmation scope**  
A confirmed file-path header applies only to the immediately following edit or to a tightly continuous sequence of edits within the same execution context.

If any of the following occur, the assistant must re-confirm the file-path header before further edits:
- a change in file target
- a change in dev plane
- a significant conversational break or topic shift
- a pause where the user re-evaluates or asks meta-questions about correctness

The assistant must not assume a prior confirmation remains valid across context shifts.

1. **Stay in the current dev plane**  
The assistant must stay within the scope of the current Dev Plane unless explicitly instructed otherwise.

2. **Surface canon misalignment**  
If the assistant detects a recommendation or change that conflicts with Canon, it must surface:
- the misalignment
- impacted areas
- likely downstream effects

3. **No pushback after decision**  
Once the user decides to proceed with a change that implies Canon updates, the assistant must not push back, debate, or stall.

4. **No silent reframing**  
The assistant must not silently reinterpret scope, intent, or decisions. Any reframing must be explicit and acknowledged.

5. **Confirm before high-impact action**  
Before implementation or structural changes with non-trivial impact, the assistant must confirm understanding if intent is not fully clear.

6. **No unsolicited optimization or cleanup**  
The assistant must not refactor, rename, optimize, or clean up unless explicitly requested.

7. **Treat the current Note as authoritative**  
Within a Dev Plane, the current Note governs scope and intent unless explicitly revised.

8. **Do not guess**  
Missing or ambiguous information requires clarification, not inference.

9. **Dev Plane update required after functional change**  
After any functional change or addition is completed, the assistant must update the current Dev Plane Note to reflect:
- what changed
- what is now true
- any new constraints or follow-on work

10. **Failure modes are captured immediately**  
If a failure occurs that is not prevented by these rules, the assistant must stop and update:
- the current Dev Plane Note, and
- this AOR section in Canon.

---

## Objective

The objective of this dev plane is to ensure that all historical (durable) candle data
hydrates exclusively through the canonical endpoint and that legacy paths are no longer
used by the UI.

---

## Scope

### In Scope
- Verifying UI usage of `/api/market/candles/window`
- Auditing and eliminating legacy historical candle calls
- Confirming durable vs intraday routing boundaries
- Updating system truth after verification

### Out of Scope
- Objective panel implementation
- AI Plane activation
- Execution Plane activation
- Any new analytics or indicators

---

## Cross-Plane Expected Interaction

- Durable Data Plane: **read**
- Intraday Plane: **read**
- Cognition Plane: **none**
- AI Plane: **none**
- Execution Plane: **none**
- UI Plane: **write**

No other cross-plane interactions are expected.

---

## Execution Checklist

- [x] Confirm all historical candles hydrate via `/api/market/candles/window`
- [x] Verify no UI calls to deprecated candle endpoints
- [x] Confirm intraday candles do not leak into durable views
- [x] Update System Status Master if findings change reality

---

## Forward-Compatibility Constraints

This work must not:
- bypass durable data truth
- introduce UI-side provider calls
- create coupling that blocks Execution Plane activation
- require rework to support AI Plane attachment later

Assumptions introduced:
- None

---

## State of Truth (As of 2026-02-07)

- Infinite refetch loop against `/api/market/candles/window` was identified in `WatchlistsPanel.tsx`
- Root cause: state was updated with a new object reference even when no derived session data was produced
- Fix applied: `setLastSessionBySymbol` is now idempotent and only updates state when a meaningful change occurs
- Canonical historical candle hydration via `/api/market/candles/window` is now stable under non-market conditions (e.g. weekends)
- Objective panel does not yet exist
- Execution and AI planes remain inactive
- Repo audit: no UI references to deprecated candle endpoints; remaining `/api/realtime/candles/intraday` and after-hours usage is server-side within candle routes (transition/fallback only)

Status: CLOSED — findings absorbed into System Status