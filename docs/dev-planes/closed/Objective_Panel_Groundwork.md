# Dev Plane — Objective Panel Groundwork

Date: 2026-02-07
Primary focus: Objective panel definition, data contract, and plane integration
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

11. **Dev Plane closure discipline**  
When a Dev Plane is closed, every item in its *State of Truth* must be explicitly resolved into exactly one of the following outcomes:

- absorbed into **System Status** if it represents current operational reality,
- absorbed into **Canon** if it establishes a rule, invariant, or ongoing constraint,
- or allowed to **remain only in the closed Dev Plane Note** as historical execution context.

State-of-Truth items must not persist implicitly across planes.

---

## Objective

The objective of this dev plane is to define the Objective panel’s role, data shape,
and cross-plane interactions such that it can be implemented later without refactoring
existing data paths, cognition flows, or execution readiness.

---

## Scope

### In Scope
- Defining the Objective panel’s purpose and boundaries
- Defining Objective → Strategy relationship (contract-level)
- Identifying required data inputs (but not building them)
- Determining persistence requirements (what must be stored)
- Establishing cross-plane expectations

### Out of Scope
- UI implementation
- Strategy execution logic
- Order routing or Execution Plane activation
- AI-driven Objective generation
- Any new data ingestion pipelines

---

## Cross-Plane Expected Interaction

- Durable Data Plane: **read**
- Intraday Plane: **none**
- Cognition Plane: **write**
- AI Plane: **prepare-for**
- Execution Plane: **prepare-for**
- UI Plane: **write**

No other cross-plane interactions are expected.

---

## Execution Checklist

- [x] Define what an “Objective” is (and is not) in TraderPro terms
- [x] Define Objective lifecycle (create, active, completed, invalidated)
- [x] Define Objective → Strategy linkage rules
- [x] Identify minimum persistence schema for Objective (narrative-first)
- [x] Identify which existing panels reference Objective (Strategy, AAR, Posture)
- [x] Update Canon or System Status if new invariants are discovered

---

## Objective Persistence Schema (Minimum)

Objectives are persisted as narrative-first records with light structural fields
used for orientation, validation, and downstream alignment.

### Table: objectives

Required fields:
- `id` (uuid)
- `account_id` (or user/org id)
- `objective_text` (text, primary narrative)
- `status` (enum: draft | active | completed | invalidated)
- `created_at`
- `activated_at`
- `closed_at`

Supporting (orientation) fields:
- `participation_modes` (json array: intraday | swing | position | observe)
- `primary_horizon` (enum: intraday | swing | position | mixed)
- `risk_posture` (enum: conservative | balanced | aggressive)

Contextual (non-binding) fields:
- `success_orientation_text` (text, broad directional goals)
- `failure_guardrails_text` (text, behavioral invalidation rules)

Notes:
- Narrative fields are authoritative over structured fields if conflict arises
- Structured fields exist to support filtering, validation, and downstream panels
- No symbol, strategy, or execution data is stored on the Objective
- JSON is acceptable for early iterations to avoid premature schema rigidity

---

## Objective → Panel Mapping

The Objective serves as the top-level cognition frame. Other panels may
reference it, but must not override or mutate it.

### Strategy Panel
- Strategy must reference exactly one Objective
- Strategy creation requires an Objective to exist (draft or active)
- Strategy ratification requires Objective status = active
- Strategy logic must be evaluated for alignment with the Objective’s narrative
- Strategy may not modify Objective content

### AAR (After-Action Review)
- Every AAR entry must reference the Objective active at the time of execution
- AAR evaluates adherence to the Objective’s philosophy and guardrails
- AAR does not redefine Objective success criteria retroactively

### Posture / Intel Panels
- Panels may read Objective context to adjust framing or emphasis
- Panels may not enforce Objective constraints
- Panels may surface signals that challenge Objective validity, but cannot invalidate it directly

### Execution Plane (Future)
- Execution is gated by:
  - Objective status = active
  - Strategy status = ratified
- Execution logic must not bypass Objective constraints
- Objective closure invalidates execution eligibility

### AI Plane (Future)
- AI may:
  - summarize Objective
  - reflect inconsistencies between Objective and behavior
  - suggest Objective revisions
- AI may not:
  - activate, close, or modify Objectives autonomously

---

## Forward-Compatibility Constraints

This work must not:
- assume live execution is present
- require real-time data subscriptions
- hard-code strategy types or timeframes
- prevent AI Plane attachment later
- introduce schema that blocks multi-objective futures

Assumptions introduced:
- Objectives are human-defined initially
- Only one “active” Objective per account at a time (tentative)

---

## State of Truth (As of 2026-02-07)

- Objective panel does not yet exist in the system
- Strategy exists but is not formally anchored to an Objective
- Execution Plane is inactive
- AI Plane is inactive
- Durable candle substrate is now stable
- Objective panel is narrative-first and intended to express the trader’s current philosophy and participation frame (“what kind of trader I am being right now”), not tactical goals or trade justification
- Objective persistence is narrative-first, with light structured fields used only for orientation and downstream alignment; no tactical or execution data is stored on the Objective
- Objective is the top-level cognition frame and is referenced (read-only) by Strategy, AAR, and Posture panels; downstream panels may not override or mutate Objective state

Status: CLOSED — findings absorbed into Canon (conceptual) and ready for implementation
