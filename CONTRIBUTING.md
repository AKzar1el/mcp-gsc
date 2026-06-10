# Contributing to mcp-gsc

Thanks for taking the time to contribute! This is a small, focused project and we like to keep it that way.

## Ways to contribute

- **Report a bug** — open an issue using the Bug report template. Include your client (Claude.ai / Cursor / ChatGPT), what you expected, and what happened.
- **Request a feature** — open an issue using the Feature request template.
- **Send a pull request** — for fixes and small, focused improvements.

## Development setup

```bash
npm install
npm test              # typecheck + offline unit tests — must pass before you open a PR
npm run dev           # local Worker via wrangler dev
```

See [SETUP.md](SETUP.md) for deploying your own instance (Google OAuth + Cloudflare KV).

### Project layout

| Path | Purpose |
|---|---|
| `src/index.ts` | Worker entry: OAuth flow (`/authorize`, `/google/callback`) and the MCP agent with the five tools. |
| `src/google.ts` | Google OAuth and Search Console API calls. |
| `src/storage.ts` | KV-backed storage of pending auth and per-user encrypted refresh tokens. |
| `src/crypto.ts` | AES-GCM encryption of refresh tokens. |
| `tests/unit.test.ts` | Offline unit tests (mocked fetch, no deployment needed) — run in CI. |
| `tests/smoke.test.mjs` | Structural smoke tests against a live deployment. |

## Pull request guidelines

- Keep PRs focused — one logical change per PR.
- Run `npm test` (typecheck + unit tests) and make sure it passes — CI runs the same.
- Never commit secrets. `wrangler.jsonc`, `.dev.vars`, and `.env*` are gitignored for a reason.
- Describe how you tested the change.

## Scope

This repository is the **self-hostable core**: four read-only Google Search Console tools plus one-click Google OAuth. Email delivery, scheduling, and the weekly-report product features live in the hosted offering at [digestseo.com](https://digestseo.com) and are out of scope here. PRs that add cron jobs, email, databases, or unrelated integrations will likely be declined — please open an issue to discuss first.

## Code of conduct

Be respectful and constructive. We follow the spirit of the [Contributor Covenant](https://www.contributor-covenant.org/).
