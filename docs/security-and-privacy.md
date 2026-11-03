# Security and privacy

## Public source does not grant model access

This release contains no publisher API key, personal deployment URL or active publisher allowance. Reading the code, diagrams or static training examples does not call a model. Running browser rules practice does not use a provider key. Anyone who chooses to operate live inference must supply their own server-side credentials and explicit usage authorization.

In the hosted Worker, public page access and paid API access are separate. Protected routes reject missing authenticated identity and reject a signed-in identity that does not match the configured operator. The key stays on the server. A public repository or public landing page does not remove these checks.

## Trusted identity is a deployment requirement

The Worker expects identity headers supplied by the supported hosting platform after authentication. It does not authenticate an arbitrary email header itself. Deploy it only behind an identity boundary that removes caller-supplied identity headers and injects verified values. Do not expose a direct origin that lets clients impersonate this trusted header source. Adapting the Worker to another host requires equivalent verified authentication and authorization; copying the header names is insufficient.

State-changing cloud requests also require same-origin JSON, bounded input and the current record or control revision. The local Node server binds to loopback and checks host/origin; it is a local prototype, not an internet-facing multi-user authentication service.

## Credentials, usage and data

- Keep real keys in ignored local configuration or hosting secrets, never in browser code, Git history, screenshots, URLs or shared archives. `.env.example` contains an empty placeholder only. Future operators configure their own identity and secrets; this snapshot does not connect to a personal deployment.
- Live work requires an unexpired, bounded server authorization and the saved model switch. Request reservations persist before dispatch; OFF blocks new dispatch, while an already dispatched request may finish and count. A conservative cost reserve is an application guard, not provider-enforced billing or a verified account balance.
- Failed provider work is not retried automatically. Output repair has a finite ceiling. An audited allowance change must preserve already used requests and cannot silently reset a counter, extend expiry or bypass a fault.
- Use fictional data only. Live inference sends the supplied synthetic text and relevant evidence to the configured model provider. Input/output checks catch selected credential-like patterns; they are not comprehensive anonymization, sensitive-data detection or a guarantee of privacy.
- Hosted live conversations are scoped to authenticated operator identity. Browser practice records stay in that browser; local events stay on the local machine. Do not publish runtime records or treat browser-local practice history as a shared production audit log.

## Human and evidence boundaries

Customer messages and retrieved articles are evidence, not authority to change application instructions. Model proposals pass program checks and remain subject to human review. Sources must support the actual claim and its conditions; a valid reference alone is insufficient.

Normal answers require explicit approval of the exact text before separate TEST delivery. Clarification uses checked question patterns and TEST delivery only. The prototype cannot alter customer settings, grant permissions, unlock records, make financial decisions or send real customer email. A successful TEST receipt does not prove customer receipt or issue resolution.

## Sharing this release

Publish a fresh reviewed snapshot, not the original working history. Exclude real environment files, runtime data, private preparation notes, account-specific hosting configuration and temporary files. Review author/committer metadata, document/image metadata, links and account ownership before publication. Even clean files cannot conceal a personal account name embedded in a repository owner or website hostname; use an appropriate neutral publishing identity and URL when anonymity is required.

The diagrams and examples are synthetic learning resources. This repository is a prototype with explicit limitations, not a completed security assessment, production deployment or full staff-training product.
