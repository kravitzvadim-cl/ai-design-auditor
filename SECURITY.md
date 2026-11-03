# Security status

This is a local prototype. Do not expose it as a multi-user service before the planned Supabase invitation-only password authentication, server-side ownership checks and private storage policies are implemented and verified. A protected homepage alone is insufficient.

Never commit .env values, provider/admin/database/mail credentials, session tokens, real-user uploads or private audit evidence. Configure deployment secrets server-side. .env.example contains variable names only. Git/container exclusions do not replace history scanning. Rotate any exposed credential and review provider activity. Do not post secrets or private source files in public issues.

Before release, run secret scans on the exact tree and all published history, dependency checks, application tests, and cross-user/unauthenticated API/file tests. Clean scans are not a guarantee of no vulnerabilities. Supabase publishable configuration is different from privileged secret keys; both require appropriate authorization policies.

No dedicated private security mailbox has been configured. Report sensitive issues through an established private maintainer channel rather than posting credentials publicly.
