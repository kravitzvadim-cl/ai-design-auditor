import { join } from 'node:path';
import { checkSupabase } from '../src/supabase-preflight.js';
try { process.loadEnvFile(join(process.cwd(), '.env')); }
catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The local configuration could not be loaded.'); }
try {
  const result = await checkSupabase(process.env.SUPABASE_URL ?? '', process.env.SUPABASE_PUBLISHABLE_KEY ?? '');
  process.stdout.write(JSON.stringify({ ...result, scope: 'Read-only configuration and anonymous API checks; not real-session/app/file acceptance.' }, null, 2) + '\n');
  if (!result.ready) process.exitCode = 3;
} catch (error) {
  process.stderr.write((error instanceof Error ? error.message : 'Supabase check failed.') + '\n');
  process.exitCode = 2;
}
