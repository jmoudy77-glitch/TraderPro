

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

    - The assistant must not issue an edit unless the user has provided the **exact file-path header line** from the editor and explicitly confirmed it is the correct file.
    - After any `oboe.edit_file` operation, the assistant must treat the change as **unverified** until the user confirms that the intended file received the edit.
    - If there is any ambiguity in tool output (e.g., generic file handles such as `Update File: 0`), the assistant must stop and re-anchor on the file-path header before attempting further edits.
    - The assistant must not attempt corrective edits until the target file has been explicitly re-confirmed.

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

## 5. Time & Market Semantics (Locked)

- Market session authority: Eastern Time (ET)
- Display semantics: user-preference overlay
- Daily candles represent regular trading session only
- Range and resolution compatibility is enforced silently

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