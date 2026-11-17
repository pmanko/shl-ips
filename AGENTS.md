# Working in `shl-ips`

`shl-ips` is a SvelteKit + TypeScript web application (`pmanko/shl-ips`, forked from `uwcirg/shl-ips`) with an `Ask WAHS` `/chat` experience wired to a `wahs-engine` backend via server-side BFF routes.

## Architecture & Guardrails

- **Server-Side Chat BFF (`src/routes/(common)/api/chat/+server.ts`):** Proxies requests to `WAHS_ENGINE_URL`, applies interactive `chart_scope` filtering, and preserves clickable `[N]` provenance mappings and HL7 `AI-Provenance` metadata.
- **Zero-Privilege Browser Boundary:** Never forward raw browser-supplied `fhir_bundle` payloads in production mode (`SERVER_LOCAL_DEMO_MODE=false`). Defer token-budget sizing to `wahs-engine` rather than hardcoding client overrides.
- **Fork PR Target Safety:** `origin` is `pmanko/shl-ips` and `upstream` is `uwcirg/shl-ips`. **Always pass `--repo pmanko/shl-ips`** to `gh pr create` / `gh pr view` unless explicitly upstreaming a change.

## Local Development & Verification

```bash
npm install
npm run check          # svelte-kit sync && svelte-check
npm run lint           # prettier --check
npm test               # vitest run
VITE_INSTANCE_ID=WAHealthSummary npm run build
npm run test:e2e       # playwright test (Chromium)
```

For local dev server preview: `npm run dev`.

## Git & PR Hygiene

- Never commit `.env` secrets, built `build/` output, or test artifacts.
- Push feature branches and open PRs against `pmanko/shl-ips` `main` early so the Dockerized unit and Playwright E2E workflows run immediately.
