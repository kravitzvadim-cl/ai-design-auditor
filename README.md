# AI Design Auditor

A working local prototype for checking documented text sizes and text colors against implemented web pages. Built with TypeScript, Node.js and Playwright/Chromium. Optional OpenRouter/Gemini Flash Lite interprets source text and suggests mappings; code performs the measurements and comparisons.

## Workflow

Add design-system links, readable uploads or pasted guidelines. Review source-backed rules, capture a public page, confirm which text each rule applies to, then inspect grouped errors with expected/measured values and screenshot locations. Unsupported coverage stays explicit; no matches or general design-quality scores.

## Run

Requires Node.js 22.22+. Install dependencies with npm ci, install the matching browser with npx playwright-core install chromium, then run npm run intake. Open http://127.0.0.1:4341/. For optional AI, copy .env.example to .env, configure OPENROUTER_API_KEY locally and restart. Never commit credentials. Manual rules/mappings work without a model.

Run npm test for deterministic fixtures and Chromium integration checks. Tests use no paid AI calls. All committed source references are synthetic; private notes, real uploads/audits and the original working Git history are excluded. Engine compatibility tests cover historical contract types; product audit scope remains font-size/text-color only.

## Status and limits

Local prototype. A Supabase schema/private bucket and database-level ownership tests are prepared. Hosted invitation/password integration, private file delivery, Linux reader parity and Render resource testing are still in progress. Do not expose the current loopback/single-user server unchanged. macOS PDF/image conversion uses PDFKit/Vision; other platforms currently provide an explicit export/manual fallback until portable readers are verified. Figma links need separate access; screenshots do not prove original CSS font size.

OpenRouter uses a fixed low-cost model with bounded requests, price ceilings, no automatic expensive fallback and a conservative $0.25 process reservation guard. Restart resets that guard; it is not a hosted user quota. AI sends only the source/page text needed for the requested interpretation.

## Security

Source code is public-facing; deployed credentials and user data must remain private. See SECURITY.md. A public repository is not a public, authenticated beta. No open-source license grant has been selected yet; no third-party source snapshots are bundled. Dependency licenses remain their respective owners' terms.

## Hosted foundation checks

`supabase/migrations/` defines invited membership, user-owned projects/records and a private file bucket. `supabase/tests/ownership.sql` uses rolled-back synthetic users to assert database isolation and revocation. This does not verify real authentication sessions, file delivery or application persistence. Configure public signup and server authentication separately before deployment.

The manually triggered Container feasibility workflow builds `Dockerfile.runtime-check` and runs an offline four-capture probe at 512 MiB and 0.1 CPU. It runs as a non-root user with Chromium sandboxing requested, no credentials and no network. A successful probe would cover this controlled sample only, not Render cold starts or arbitrary websites. The image entry point is a probe, not the hosted app.
