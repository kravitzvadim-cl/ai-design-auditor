import { mkdir, copyFile, readFile, writeFile } from 'node:fs/promises';

try { process.loadEnvFile(); }
catch (error) { if (error.code !== 'ENOENT') throw error; }

const url = process.env.SUPABASE_URL;
const publishableKey = process.env.SUPABASE_PUBLISHABLE_KEY;
if (!/^https:\/\/[a-z0-9]{20}\.supabase\.co$/.test(url ?? '') ||
    !/^sb_publishable_[A-Za-z0-9_-]{10,}$/.test(publishableKey ?? '')) {
  throw new Error('Set the Supabase project URL and browser publishable key for this build.');
}

const output = new URL('../dist/access-request/', import.meta.url);
const source = new URL('../access-request/', import.meta.url);
await mkdir(output, { recursive: true });
const html = await readFile(new URL('index.html', source), 'utf8');
await Promise.all([
  writeFile(new URL('index.html', output), html.replace('__SUPABASE_ORIGIN__', url)),
  writeFile(new URL('config.js', output), 'export const url = ' + JSON.stringify(url) + ';\nexport const publishableKey = ' + JSON.stringify(publishableKey) + ';\n'),
  ...['style.css', 'request.js'].map(file => copyFile(new URL(file, source), new URL(file, output))),
]);
