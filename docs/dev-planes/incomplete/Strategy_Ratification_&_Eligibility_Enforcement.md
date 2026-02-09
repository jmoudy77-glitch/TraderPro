

Dev Plane — Strategy Ratification & Eligibility Enforcement

Date: 2026-02-07
Status: INCOMPLETE (Blocked — Strategy persistence not yet wired)

Primary Focus:
UI-level enforcement of Strategy eligibility based on existing governance

Related Canon:
- docs/canon/TRADERPRO_CANONICAL_SPEC.md

Related System Status:
- docs/ops/TRADERPRO_SYSTEM_STATUS_MASTER.md

⸻

Assistant Operating Rules (Active)

This Dev Plane is governed by the active AOR embedded in the source Apple Note at the time of execution.
The AOR is not duplicated here to avoid drift; this file records execution state and outcomes only.

⸻

Objective

The objective of this dev plane is to enforce existing Strategy governance rules at the UI level by gating the Strategy “Activate” action.

Activation is a one-step user action that both:
- ratifies the Strategy as aligned with the ACTIVE Objective for the current session, and
- activates the Strategy as the governing plan for that trading day.

This plane explicitly avoids introducing execution behavior, automation, AI logic, authentication plumbing, or backend enforcement.

⸻

Scope

In Scope
- UI enforcement of Strategy eligibility rules
- Visual representation of Strategy states (READY / STALE / EXPIRED / INVALID)
- Blocking of ineligible Strategy affordances
- Strategy activation affordance (one-step ratification + activation)
- Read-only detection of trading session boundaries (ET-based)

Out of Scope
- Trade execution or order lifecycle
- Strategy automation or monitoring
- AI critique, inference, or enforcement
- Authentication or login work
- Strategy content generation or editing logic
- Backend or server-side enforcement

⸻

Execution Checklist

Checklist Interpretation:
Items in this checklist are checked only when the behavior exists and has been verified in the UI.
Design decisions and governance constraints are captured in prose sections and do not imply checklist completion.

Eligibility & Gating
- [x] Strategy panel derives and applies eligibility state deterministically at render
- [x] ACTIVE Objective presence is enforced as a hard prerequisite
- [ ] Strategy–Objective mismatch is detected and marked STALE
- [ ] Session mismatch is detected and marked EXPIRED
- [ ] Ineligible Strategies cannot be Activated

Blocked pending Strategy persistence wiring:
- Strategy–Objective mismatch detection
- Session mismatch detection
- Ratification recording

Activate (One-Step Ratification)
- [x] Activate button is the sole ratification mechanism
- [ ] Activate is disabled when Strategy is INVALID / STALE / EXPIRED
- [ ] Activate records ratification facts for the current session
- [x] No implicit or background ratification occurs
- [x] Re-Activate is required every new trading session

Visual State Communication
- [ ] READY / STALE / EXPIRED / INVALID states are visually distinct
- [ ] Exactly one primary state is shown at a time
- [ ] State explanation text is present and accurate
- [ ] Required next action (if any) is clearly indicated

Non-Goals Enforcement
- [x] No trade execution paths are reachable from Strategy panel
- [x] No Monitor agent behavior is triggered in this plane
- [x] No AI critique, inference, or automation is introduced
- [x] No auth or login dependency is added

Verification & Closure
- [ ] Manual UI walk-through confirms all gates behave as specified
- [ ] No eligible path bypasses governance rules
- [ ] System Status updated to reflect UI enforcement
- [ ] Dev Plane Note updated with final State of Truth

⸻

State of Truth (As of 2026-02-07)

- Strategy governance semantics are fully defined in Canon
- Strategies are Objective-bound and session-scoped
- UI-level eligibility derivation exists in StrategyPanel
- ACTIVE Objective prerequisite is enforced in the UI
- Strategy persistence (objective binding, ratification records) does not yet exist
- Execution and AI planes remain gated and inactive

⸻

Governance Inputs (Authoritative)

Canon
- Strategy validity requires an ACTIVE Objective
- Strategy ratification is explicit and Objective-bound
- Strategies are session-bound and expire at session end (§5.a)

System Status
- Objective → Strategy linkage is GOVERNANCE-DEFINED
- UI enforcement is partially implemented; persistence is deferred

This plane may not redefine or extend these rules.

⸻

Strategy Eligibility Model (Consumed, Not Defined)

A Strategy is eligible for activation only if all are true:
1. Exactly one Objective is ACTIVE
2. Strategy is ratified against that Objective
3. Strategy is ratified for the current trading session

Derived states:
- INVALID — missing Objective or ratification
- STALE — Objective changed after ratification
- EXPIRED — session boundary passed

Eligibility is binary; states are explanatory.

⸻

Session Boundary Definition (Governance)

- Strategy session validity is evaluated against the US equities regular trading session
- Session authority is Eastern Time (ET)
- The canonical session key is the ET calendar date in YYYY-MM-DD format
- A Strategy is EXPIRED when its ratified_session does not match the current session key
- No pre-market, after-hours, or holiday logic is introduced in this plane

⸻

UI Enforcement Principles

- Ineligible Strategies must be clearly labeled
- Ineligible Strategies must be non-interactive for downstream actions
- No silent failures
- No automatic repair or carryover
- No implicit re-ratification

UI communicates governance truth; it does not negotiate it.

Activate Control Semantics

- The Strategy panel exposes a single primary action: Activate
- Activate is the only mechanism by which a Strategy may be ratified and activated for a session
- Activate is never hidden; it is either enabled or disabled with explanation
- No alternate CTAs (e.g. “Re-Activate”, “Fix”, “Auto-Update”) are permitted in this plane
- Eligibility state is communicated adjacent to the Activate control to ensure intent precedes action

⸻

Exit Criteria

This dev plane may be resumed or closed when:
- Strategy persistence exists with objective binding and ratification fields
- UI eligibility enforcement can be fully completed
- Remaining checklist items are verifiable

⸻

Notes

This Dev Plane was intentionally paused after partial UI enforcement due to the absence of Strategy persistence.
Its record is retained to preserve governance intent, discovered constraints, and correct sequencing for future work.