# Architecture

This is a working support-workflow prototype with synthetic emails, a small attributed knowledge collection and explicit human review. It includes real model integration code, deterministic practice and a read-only learning catalogue. It is not a complete production support platform or employee-training system.

## Experiences and runtime

| Experience | Purpose | Model use and storage |
| --- | --- | --- |
| Training examples (`/`) | Read ten fictional scenarios, expected handling, flow steps and reviewer checks. | One static catalogue load; no model, approval, sending or saved-history access. |
| Conversation practice (`/practice`) | Exercise clarification, review and test delivery using deterministic rules. | Hosted practice uses browser-local records; the local Node runtime uses local event files. |
| Knowledge & review guide (`/legacy`) | Inspect three curated articles, review principles, practice records and optional earlier rules practice. | Hosted practice records remain in the current browser and are separate from live records. |
| Owner live workspace (`/live`, hosted runtime) | Process synthetic conversations with a real model and a bounded allowance. | Requires trusted authenticated identity, an authorized operator and the operator's own server-side configuration. Records use namespaced D1 storage. |

No personal deployment is configured in this release. A future operator provisions their own hosting identity, storage, secrets and usage authorization.

## Processing flow

1. Validate the synthetic email, deduplicate its event and restore conversation context.
2. Make one triage model call to identify intentions, risks, a human request, missing information and retrieval direction. Program rules validate the result and enforce routing constraints.
3. If customer information is missing, check a specific clarification against approved patterns, deliver it to the **TEST outbox**, then wait. Merge the reply with the earlier messages and triage again. Clarification is bounded; it cannot loop indefinitely.
4. Otherwise retrieve relevant passages from the versioned collection using keyword-based ranking. This is not vector search. Empty retrieval, risk, conflicting evidence or unsupported instructions lead to human handling.
5. Make one evidence-assessment and drafting call. Check schema, citations and fixed constraints. A draft can receive up to three corrective retries after its first attempt. Repairs reuse the evidence and cannot manufacture missing support. Other failures remain visible for human inspection.
6. Let a person inspect the evidence, conditions and wording. They can edit, reject or explicitly approve the exact reply. Rejecting a draft does not resolve the customer's issue. Department assignment and follow-up tracking are not implemented.
7. Persist the approved body, source version, reviewer decision and body hash. A separate send action accepts that saved version, not replacement text. The durable application **TEST outbox** records acceptance or a failed/unknown result. It never contacts an email service.

## Evidence and audit boundaries

Prompts, schemas and curated source facts are versioned. Original model output is retained separately from deterministic routing overrides and validation feedback. Internal source IDs must match retrieved references. Before review, generated customer text replaces those IDs with cited article titles and exact source URLs; approval covers the resulting full text.

A valid schema or citation ID does not establish semantic support, account permissions, a saved time entry or a successful customer outcome. These remain reviewer checks. An unverified setting prerequisite stays conditional; a reported permission block or suspected bug requires human attention.

Local persistence uses append-only snapshot transactions; hosted state uses version-checked D1 writes with event snapshots. Revisions, stable event IDs and delivery IDs protect against stale edits and duplicate work. Interrupted work becomes visible; uncertain delivery requires reconciliation rather than blind resending. These records are useful provenance, not a claim of a tamper-proof production audit system.

The diagrams show the intended business workflow. In this implementation, real mailbox delivery is replaced by the TEST outbox, and customer accounts are never modified. Deterministic fixtures and curated training answers demonstrate expected behavior; they are not real-model quality measurements or production validation.
