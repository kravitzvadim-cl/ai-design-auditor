import { checkSupabase } from '../src/supabase-preflight.js';
import { SupabaseWorkspace } from '../src/supabase-workspace.js';
import { betaServer } from '../src/beta-server.js';

try { process.loadEnvFile(); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('Local configuration could not be loaded.'); }

// Preview uses manual rule mapping and per-user Supabase access.
delete process.env.OPENROUTER_API_KEY;
delete process.env.FIGMA_ACCESS_TOKEN;
const url = process.env.SUPABASE_URL ?? '';
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY ?? '';
const readiness = await checkSupabase(url, publishableKey);
if (!readiness.ready) throw new Error('Supabase access checks failed. Run npm run check:supabase.');
const port = Number(process.env.AUDITOR_PREVIEW_PORT ?? '4342');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid AUDITOR_PREVIEW_PORT.');
const origin = `http://127.0.0.1:${port}`;
betaServer(origin, new SupabaseWorkspace({ url, publishableKey })).listen(port, '127.0.0.1', () => {
  process.stdout.write(`Private workspace preview: ${origin}/\n`);
});
