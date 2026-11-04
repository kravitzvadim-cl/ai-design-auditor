# AI Design Auditor

A working local prototype for checking documented text sizes and text colors against implemented web pages. Built with TypeScript, Node.js and Playwright/Chromium. Optional OpenRouter/Gemini Flash Lite interprets source text and suggests mappings; code performs the measurements and comparisons.

## Workflow

Add design-system links, readable uploads or pasted guidelines. Review source-backed rules, capture a public page, confirm which text each rule applies to, then inspect grouped errors with expected/measured values and screenshot locations. Unsupported coverage stays explicit; no matches or general design-quality scores.

## Run

Requires Node.js 22.22+. Install dependencies with npm ci, install the matching browser with npx playwright-core install chromium, then run npm run intake. Open http://127.0.0.1:4341/. For optional AI, copy .env.example to .env, configure OPENROUTER_API_KEY locally and restart. Never commit credentials. Manual rules/mappings work without a model.

Run npm test for deterministic fixtures and Chromium integration checks. Tests use no paid AI calls. All committed source references are synthetic; private notes, real uploads/audits and the original working Git history are excluded. Engine compatibility tests cover historical contract types; product audit scope remains font-size/text-color only.

## Private workspace preview

Set the Supabase URL and publishable key from .env.example in ignored .env. Apply the migration under supabase/migrations/ and turn off public signup. Run `npm run beta:preview` and open http://127.0.0.1:4342/. Sign in with an invited account to create projects, save rules, download originals and reopen reports with screenshots. The preview runs the live access checks before starting.

The hosted beta runs the same workspace in link-only mode. Its Docker command is `node dist/tools/start-beta-preview.js --hosted`. Render provides the HTTPS origin and port. The service uses the Supabase URL and publishable key. The hosted beta uses manual rule mapping and supports text sources and Figma JSON exports. For PDFs, images and Word files, enter the rules manually or upload a text export.

To invite a tester, first mark their request `approved` in Supabase. On the owner's computer, add `SUPABASE_ADMIN_KEY` to ignored `.env` and run `node tools/create-beta-link.mjs tester@example.com`. Share the resulting one-time link privately. The hosted service and public form never receive the admin key. Ask the owner for a fresh link after signing out or when the session expires.

The optional public beta request page is separate from the audit app. Apply the beta access requests migration, then run `node tools/build-access-request.mjs` with `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` set. Host `dist/access-request` as a static site. Requests go to the private `beta_access_requests` table as pending; the form neither sends email nor creates accounts.

Tests exercise password and link sign-in, active membership, cross-account route denial and reopening saved work after a restart against a simulated Supabase service. A real invited-account test, representative Render workloads and portable document readers remain release checks.

## Status and limits

The local intake and the private workspace preview have separate entry points. The preview listens on loopback. macOS PDF/image conversion uses PDFKit and Vision. Other platforms offer an export or manual fallback while portable readers are in development. Figma links need their own access connection or export.

OpenRouter uses a fixed low-cost model with bounded requests, price ceilings, no automatic expensive fallback and a conservative $0.25 process reservation guard. Restart resets that guard; it is not a hosted user quota. AI sends only the source/page text needed for the requested interpretation.

## Security

Source code is public-facing; deployed credentials and user data must remain private. See SECURITY.md. A public repository is not a public, authenticated beta. No open-source license grant has been selected yet; no third-party source snapshots are bundled. Dependency licenses remain their respective owners' terms.

## Hosted foundation checks

`supabase/migrations/` defines invited membership, user-owned projects/records and a private file bucket. `supabase/tests/ownership.sql` uses rolled-back synthetic users to assert database isolation and revocation. The application preview uses the signed-in user session for those same policies. Real hosted sign-in and storage checks are release gates.

The manually triggered Container feasibility workflow builds `Dockerfile.runtime-check` and runs an offline four-capture probe at 512 MiB and 0.1 CPU. It runs as a non-root user with Chromium sandboxing requested, no credentials and no network. A successful probe would cover this controlled sample only, not Render cold starts or arbitrary websites. The image entry point is a probe, not the hosted app.

The first restricted Linux/container probe could not start Chromium sandboxing. A subsequent actual Render Free probe passed four fixed synthetic captures/comparison with sandboxing requested: 30.1 seconds, 269.6 MiB peak memory, 512 MiB memory limit. This verifies that controlled sample only; real website/upload workloads, cold starts and user capacity remain unverified. The probe exposes no audit application routes or secrets. Source tests run on Ubuntu 22.04 with Chromium sandboxing enabled, without changing host security settings.

`npm run check:supabase` checks the configured hosted project's signup setting, anonymous data denial and invalid-session denial using only its publishable key. Set the two Supabase variables in ignored `.env`; no secret/service-role key is accepted. Exit 3 means a readiness check is blocked, and exit 2 means configuration/transport failure. This read-only check creates no users or data. Passing it is necessary before release, but does not prove real-session ownership, application login, private file delivery or email delivery.
