

# Dev Plane — Login Plumbing & JWT-Bound Server Clients

**Date:** 2026-02-09
**Primary focus:** Bind authenticated user identity (JWT) to Supabase server clients to remove dev-only service-role fallback and enable safe progression toward Execution and AI planes.
**Related Canon:** docs/canon/TRADERPRO_CANONICAL_SPEC.md
**Related System Status:** docs/ops/TRADERPRO_SYSTEM_STATUS_MASTER.md

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

    - The assistant must not issue an edit unless the assitant has provided the **exact file-path header line** from the editor and user has explicitly confirmed it is the correct file.
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
    If a new fact or state discovery affects sequencing, the assistant must:
    1) update the Dev Plane Execution Checklist, then
    2) propose or begin the next execution step.

---

## Objective

Establish a secure, production-valid authentication plumbing layer where:
- JWT-authenticated users are correctly bound to Supabase server clients
- All Cognition-plane APIs operate under user-scoped authority (not service role)
- Dev-only privilege paths are removed or explicitly gated

This plane enables downstream activation of Execution and AI planes **without refactoring governance logic**.

---

## Scope

### In Scope
- JWT extraction and validation in API routes
- Binding JWT → Supabase server client (PostgREST / RPC)
- Removal or explicit gating of dev-only service-role fallback
- User ownership enforcement at the DB boundary
- Alignment of auth behavior across Cognition-plane endpoints
- System Status updates reflecting auth readiness

### Out of Scope
- UI login / signup flows
- OAuth provider configuration
- Role-based permissions beyond owner identity
- Execution Plane activation
- AI Plane activation

---

## Execution Checklist

### Authentication Plumbing
- [x] Confirm current JWT validation behavior across Cognition endpoints
- [x] Inventory all routes using dev-only service-role fallback
- [x] Implement JWT-bound Supabase server client creation
- [x] Gate or remove service-role fallback behind explicit dev flag
- [x] Enforce owner identity at the DB query boundary

### Endpoint Alignment
- [x] Update `/api/objective/*` to use JWT-bound Supabase clients
- [x] Update `/api/strategy/*` to use JWT-bound Supabase clients

### Safety & Verification
- [x] Verify unauthenticated requests return `401`
- [x] Cross-user access rejected (no caller-provided principal; owner identity derived from JWT/dev actor; scheduler endpoints internal-auth + fixed owner)
- [x] Verify dev environment works **only** with explicit dev flag enabled
- [x] Implicit privilege escalation paths removed (no unconditional service-role; scheduler endpoints internal-auth + service-role only after auth)

### Documentation & Closure
- [x] Update System Status to reflect auth readiness
- [x] Update State of Truth after verification

---

## State of Truth (Final)

- Cognition-plane APIs bind JWTs to Supabase server clients for all user-scoped access
- Dev-only service-role fallback exists only behind explicit development flags
- Cross-user data access is impossible by construction at the DB boundary
- Scheduler and legacy endpoints are internal-only and require scheduler secret authentication
- Execution and AI planes remain gated but unblocked by auth plumbing

---

## Exit Criteria

This Dev Plane is **closed** when:

- JWT-bound Supabase server clients are used across all Cognition endpoints
- Dev-only service-role fallback is removed or explicitly gated
- Cross-user data access is impossible at the DB boundary
- System Status reflects auth readiness accurately

**Status:** CLOSED