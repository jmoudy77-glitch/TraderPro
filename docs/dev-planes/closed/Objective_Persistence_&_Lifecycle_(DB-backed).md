

# Dev Plane — Objective Persistence & Lifecycle (DB-backed)

Date: 2026-02-07  
Primary focus: Objective persistence and lifecycle truth  
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

12. **Checklist-first execution (no execution by implication)**  
    If a new fact or state discovery affects sequencing, the assistant must update the Execution Checklist before proceeding.

---

## Objective

Introduce database-backed persistence and lifecycle truth for the Objective panel, establishing a durable and authoritative Objective entity suitable for downstream planes.

This plane establishes **truth, not behavior**.

---

## Scope

### In Scope
- Objective database schema
- Objective lifecycle states (`draft`, `active`, `closed`)
- Enforcement of a single ACTIVE Objective invariant
- Persisting Objective state on Save Draft / Activate / Close
- Refactoring Objective controller to source truth from the database

### Out of Scope
- Strategy validation or enforcement
- Execution hooks or order behavior
- AI critique, reflection, or inference
- Objective UI redesign
- Multi-objective history UX (beyond basic storage)

---

## Execution Checklist (Final)

- [x] Decide reuse vs new table for Objective persistence
- [x] Confirm Objective is long-lived (not day-aligned)
- [x] Define `objective_frames` data model
- [x] Enforce single ACTIVE Objective invariant
- [x] Implement DB schema + constraints
- [x] Load Objective from DB on app init
- [x] Persist Draft on Save
- [x] Persist ACTIVE on Activate
- [x] Persist CLOSED on Close
- [x] Confirm Objective survives refresh
- [x] Confirm ACTIVE invariant enforced
- [x] Confirm no Strategy / Execution / AI coupling introduced
- [x] Dev Plane Note updated after functional changes

---

## State of Truth (Resolved)

- Objective persistence is DB-backed (draft / active / closed)
- ACTIVE invariant enforced at DB level
- Objective lifecycle is authoritative and durable
- Dev-only identity fallback is required until login/auth plane exists
- Auth-path routes validate JWTs but do not yet bind JWTs to Supabase DB clients (recorded in System Status)

All State-of-Truth items have been absorbed into **System Status** or **Canon** as appropriate.