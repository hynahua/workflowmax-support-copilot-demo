# WorkflowMAX Support Copilot

A support-workflow prototype that turns a synthetic email into a grounded draft, a focused clarification or a visible human handoff. A reviewer checks the evidence and approves the exact reply before a separate TEST-outbox action. No real customer mailbox or account is connected.

This release contains the application source, tests, versioned prompts and contracts, curated public references, ten training examples and two complementary workflow diagrams. Deployment identities, private working notes, real credentials, runtime records and original Git history are excluded.

## Start here

- **Training examples:** ten read-only fictional emails with expected handling, flowchart steps and reviewer checks. Reading them calls no model.
- **Knowledge & review guide:** three attributed public support articles, review guidance and optional rules practice.
- **Conversation practice:** a deterministic multi-turn workflow saved locally or in the visitor's browser. This is rehearsal, not model evaluation.
- **Owner live workspace:** the hosted adapter permits the configured owner to call a real model using that operator's own server-side key and bounded allowance. Public training access does not grant paid API access.

A neutral public demo URL has not been configured in this release. No personal deployment URL or paid access credential is included.

## Run locally

Node.js22+ is required; Node24 is recommended for built-inSQLite verification.

```sh
npm ci
npm run rehearsal
```

Open the printed loopback address. `/` shows training examples, `/practice` opens the conversation rehearsal and `/legacy` opens knowledge/review references. `npm run demo` chooses a free port and opens the browser on macOS. `npm run dev` disables generation while allowing inspection.

The local navigation calls its conversation entry **Local practice workspace**. It never redirects to the publisher's deployment.

## Workflow diagrams

The colorful map helps remember the main stages and loops. It is a learning aid, not a complete topology specification.

![Color workflow memory map](diagrams/workflow-memory-map.png)

The precise English flowchart preserves the detailed branches and decisions:

- [English flowchart PNG](diagrams/workflow-english.png)
- [English flowchart SVG](diagrams/workflow-english.svg)
- [Editable Mermaid source](diagrams/workflow-english.mmd)

The target diagram labels future delivery integrations; this prototype uses only a TESToutbox. The initial draft may be followed by at most three repair attempts. Programmatic format/citation checks do not prove factual support.

## Verify

```sh
npm run check
npm test
npm run build:share
```

Tests use mocks or deterministic rules, including owner authorization, preserved model budgets, source boundaries, clarification, bounded repairs, explicit approval, immutable approved text and uncertain delivery. They do not request a real model or change customer data. `eval:rehearsal` is an optional twelve-case deterministic report; live evaluation remains separately opt-in and needs the operator's own approved setup.

`build:share` creates an ignored `cloud-site/` build from allowlisted code and synthetic/public inputs. It makes no deployment or API call. The portable build can omit a Site projectID; an operator must configure their own Site identity and bindings before publication. No existing operator deployment is bound to this release.

## Optional real-model setup

Real generation is disabled by default. For a local live session, an operator supplies their own untracked `.env.local` using `.env.example` and their own reviewed `runtime/approved-live-plan.json` containing an ID, finite request and US-dollar limits, and a future ISO expiry. Only then use `npm run live` and the local conversation route. A key alone does not supply an active allowance.

For the hosted adapter, use Sites-managed identity and configure the operator's own `OPENAI_API_KEY`, `LIVE_OPERATOR_EMAIL` and `LIVE_APPROVED_PLAN` as server secrets, plus a D1binding namedDB. The Worker trusts identity headers supplied by the hosting proxy; another hosting environment must provide an equivalent verified identity boundary and strip forged client headers. Never expose this adapter behind an untrusted identity proxy.

There are no real keys, deployed grant values or customer records in this repository. Cloning it gives no access to another operator's model budget. Never enter credentials or real customer information into synthetic training fixtures.

## Implementation

Native NodeHTTP, buildless HTML/CSS/JavaScript and Ajv; esbuild packages browser/Worker artifacts. Prompts and JSONcontracts are versioned. Local state uses append-only events; hosted owner state uses D1with version checks. The current knowledge collection is three curated articles with keyword retrieval; vector retrieval is not implemented.

See [architecture](docs/architecture.md), [security and privacy](docs/security-and-privacy.md), [validation](docs/validation.md) and [release notes](docs/release-notes.md).
