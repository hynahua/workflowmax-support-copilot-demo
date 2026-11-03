# Validation of the sanitized source snapshot

The release was installed independently with the locked dependencies, then verified with:

- `npm run check`: JavaScript syntax and JSON contracts passed.
- `npm test`: **163 passed, 0 failed, 0 skipped**. Provider calls in these tests are mocked or deterministic; no live model evaluation was performed.
- `npm run build:share`: browser and Worker artifacts built successfully without a personal deployment identity. The build does not publish them.

The tests exercise clarification/context, bounded repairs, citation/source boundaries, conditional claims, human handoff, owner authorization, durable request limits, concurrent changes, explicit approval, immutable approved text, TEST delivery and visible failures. This is prototype verification, not production UAT, a complete security audit or an accuracy benchmark for a live model.

Anonymous status-only checks against the current deployment returned HTTP 401 for both protected status/conversation endpoints. A further anonymous request with synthetic forged identity headers also returned 401. These checks dispatched no model and made no customer-data changes. The linked deployment remains owner-gated for real-model calls.

The source privacy review excludes original Git history, environment values, runtime records, private documents, account-specific deployment references and personal commit identities. The approved diagram assets retain the original bytes; their text/EXIF metadata review found no identity-bearing fields. The existing public GitHub account name and demo address are intentionally retained; real personal contact details, private documents and credentials are not.
