# Visual Workspace and Audit Engine

Reusable country-neutral engine. Initial capabilities and limits are documented in [architecture](docs/ARCHITECTURE.md); the canonical work plan is [registry/prs.json](registry/prs.json).

```sh
npm ci
npm run check
```

All research and jurisdiction configuration belong in downstream deployments. Implementation, local tests, CI, merge and live acceptance are separate.

The opt-in `./consent-review` module adds [private participant consent inspectors](docs/CONSENT_REVIEW.md), including original capture receipts and current withdrawal without inferring use authorization. Generate its fictional example with `npm run example:consents`.
