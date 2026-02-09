

# TraderPro — Canonical Spec & Operating Manual

> **Purpose**  
> This document defines the stable intent, boundaries, and operating assumptions of TraderPro.  
> It describes what *must remain true* unless explicitly revised. It is not a roadmap or a system status report.

---

## 0. Document Scope & Authority

- This document represents **canonical intent**, not implementation detail.
- When conflicts arise, authority is resolved in the following order:
  1. Canonical Spec & Operating Manual
  2. System Status Master
  3. Dev Plane Notes
- Temporary deviations may exist, but must be visible in the System Status Master.

---

## 1. What TraderPro Is (and Is Not)

**TraderPro is:**
- An analysis and decision-support platform
- A repeatable cognition loop:
  ```
  analysis → strategy → ratification → monitoring → alerts → AAR
  ```
- Deterministic and replayable at the analysis layer
- Designed as a **multi-plane system** where all primary planes are first-class, even if activation is phased

**TraderPro is not:**
- A passive charting site
- A provider-facing client
- An execution-led product

---

## 2. Prime Directives (No Drift)

1. The UI never talks to providers directly.
2. All market truth enters through the backend.
3. Durable analytics derive only from durable data.
4. Intraday data provides freshness, not authority.
5. Execution behavior is gated behind strategy formalization and ratification.

---

## 3. Assistant Operating Rules (AOR)

> **Scope**  
> These rules govern assistant behavior during active development and documentation. They exist to preserve shared context, prevent drift, and avoid repeated failure modes.

### Assistant Operating Rules

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
If a new fact or state discovery affects sequencing (e.g., “component does not exist,” “UI is not implemented,” “endpoint is deprecated,” “layout differs from assumption”), the assistant must:
1) update the Dev Plane Execution Checklist to reflect the new reality, and only then
2) propose or begin the next execution step.

The assistant must not proceed based on implied next steps when the checklist has not been updated to reflect the discovered state.

---

## 3.a Canonical Dev Plane Template

All development work must be instantiated using the following Dev Plane structure.
This template is mandatory and exists to prevent scope drift, implicit execution,
and loss of procedural discipline.

Deviation from this template requires explicit declaration in the Dev Plane Note.

---

# Dev Plane — <Name>

Date:
Primary focus:
Related Canon: docs/canon/TRADERPRO_CANONICAL_SPEC.md  
Related System Status: docs/ops/TRADERPRO_SYSTEM_STATUS_MASTER.md  

---

## Assistant Operating Rules (Active)

<paste full AOR verbatim>

---

## Objective

The objective of this dev plane is to:

---

## Scope

### In Scope
- 

### Out of Scope
- 

---

## Execution Checklist

- [ ] 
- [ ] 
- [ ] 

---

## Forward-Compatibility Constraints

- 
- 

---

## State of Truth (As of <timestamp>)

- 
- 

## 4. Canonical System Planes (High Level)

TraderPro is composed of the following primary planes. Each plane is first-class in system design, even if activation is phased.

- **Durable Data Plane**  
  Finalized market data and the exclusive substrate for repeatable analytics.

- **Intraday Plane**  
  Real-time freshness, monitoring, volatility, and market-state awareness.

- **Cognition Plane**  
  Human reasoning surfaces including notes, strategy, posture, and review (AAR).

- **AI Plane**  
  Assistive intelligence responsible for synthesis, pattern surfacing, explanation, drafting, and discipline reinforcement.  
  AI never bypasses durable truth and never acts as an autonomous decision authority.

- **Execution Plane**  
  Order intent, validation, routing, and lifecycle management.  
  Execution is gated behind strategy formalization and ratification and is never active without explicit user intent.

- **UI Plane**  
  Presentation, interaction, and visualization only; no provider or execution authority.

---

## 4.a UI Shell — Right Rail Panel Wrapper Contract

All right-rail panels must conform to a shared structural wrapper to ensure
visual stability, consistent cognition surfaces, and predictable layout behavior.

This contract exists to prevent partial-height panels, background bleed-through,
and inconsistent interaction affordances across the cognition stack.

### Canonical Wrapper Requirements

Every right-rail panel MUST:

- Fill its allocated rail slot completely
- Paint an opaque, canonical surface (no transparency reliance)
- Use a predictable header / body / footer flex structure
- Never collapse to content height within a flex slot

### Required DOM Structure

Each panel must render the following structure at its root:

```txt
Rail Slot (provided by layout):  <div class="min-h-0 flex-1"> … </div>
  Panel Root:                   <section class="h-full min-h-0 flex flex-col …">
    Panel Header (optional):    <header class="shrink-0 …">
    Panel Body:                 <div class="min-h-0 flex-1 overflow-auto …">
    Panel Footer (optional):    <footer class="shrink-0 …">
```

Non-negotiables:
- `h-full min-h-0 flex flex-col` on the panel root
- `min-h-0 flex-1` on the panel body
- Headers and footers must be `shrink-0`

### Canonical Surface Tokens

- Background: `bg-neutral-950` (or canonical rail surface token)
- Border: `border border-neutral-800`
- Radius: `rounded-lg`

Panels must not rely on page or container backgrounds for visual continuity.

### Canonical Implementation

The canonical implementation of this contract is provided by:

- `src/components/RailPanelFrame.tsx`

All right-rail panels (Objective, Strategy, Notes, and future additions) must use
this wrapper or implement an equivalent structure that fully satisfies this contract.

### Right Rail Stack Order (Canonical)

Top → Bottom:

1. Objective Panel
2. Strategy Panel
3. Notes Panel


## 5. Time & Market Semantics (Locked)

- Market session authority: Eastern Time (ET)
- Display semantics: user-preference overlay
- Daily candles represent regular trading session only
- Range and resolution compatibility is enforced silently

### 5.a Strategy Session-Bound Validity (Invariant)

Strategies in TraderPro are inherently session-scoped.

A Strategy is valid only for the trading session it is explicitly ratified for. At the conclusion of that session, the Strategy expires automatically.

- No Strategy carries forward across sessions by default.
- A new trading session always requires explicit Strategy re-ratification.
- Session expiration applies regardless of Objective continuity or change.

This invariant exists to preserve disciplined, intentional trading behavior and to prevent cognitive drift across market days.

#### Relationship to Objective Governance

Strategy session expiration is orthogonal to Objective alignment:

- Objective governance determines whether a Strategy is conceptually valid.
- Session binding determines whether a Strategy is temporally eligible.

A Strategy must satisfy both conditions to be usable:
1. It is valid relative to the currently ACTIVE Objective.
2. It is ratified for the current trading session.

Failure of either condition renders the Strategy ineligible.

#### Explicit Non-Implications

This invariant does not imply:
- Trade execution
- Automation
- AI decision-making
- Order persistence
- Session-based carryover logic

It establishes governance truth only. Other planes may consume this truth but may not override it.

---

## 6. Data Authority & Provider Policy

- Alpaca is the sole market data provider
- Providers never bypass durable truth
- Analytics and intelligence planes never call providers directly

---

## 7. What This Document Is Not

- Not a task list
- Not a roadmap
- Not a system status report
- Not a justification for shortcuts

---

## 8. Change Policy

- Canon changes are explicit and intentional
- Rationale should be documented briefly
- System Status must reflect reality immediately after any Canon-impacting change

---

_End of Canonical Spec & Operating Manual_