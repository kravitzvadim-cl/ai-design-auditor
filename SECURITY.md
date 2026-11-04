# Security status

The private preview verifies the Supabase user and active membership on protected requests. Each project and file request carries the user's access token and relies on the project's ownership policies. Passwords go through Supabase Auth. The preview uses HTTP-only cookies and an exact request origin. HTTPS mode adds the Secure cookie flag. Real account and file tests are required before release.

Never commit .env values, provider/admin/database/mail credentials, session tokens, real-user uploads or private audit evidence. Configure deployment secrets server-side. .env.example contains variable names only. Git/container exclusions do not replace history scanning. Rotate any exposed credential and review provider activity. Do not post secrets or private source files in public issues.

Before release, run secret scans on the exact tree and all published history, dependency checks, application tests, and cross-user/unauthenticated API/file tests. Clean scans are not a guarantee of no vulnerabilities. Supabase publishable configuration is different from privileged secret keys; both require appropriate authorization policies.

No dedicated private security mailbox has been configured. Report sensitive issues through an established private maintainer channel rather than posting credentials publicly.
