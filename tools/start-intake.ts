import { mkdir, stat } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { intakeServer } from '../src/intake-server.js';
const root = process.cwd();
try { process.loadEnvFile(join(root, '.env')); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('The local .env file could not be loaded.'); }
if (process.platform === 'darwin') {
  const folder = join(root, 'reports/runtime'); await mkdir(folder, { recursive: true });
  const reader = join(folder, 'asset-reader'); const source = join(root, 'tools/read-asset.swift');
  const binary = await stat(reader).catch(() => null);
  if (!binary || binary.mtimeMs < (await stat(source)).mtimeMs) {
    process.stdout.write('Preparing the local PDF/image reader…\n');
    try { await promisify(execFile)('/usr/bin/swiftc', ['-module-cache-path', join(folder, 'swift-cache'), source, '-o', reader], { timeout: 120000, maxBuffer: 1_000_000 }); }
    catch { process.stderr.write('Local image/PDF reader unavailable. File attachment and manual rules still work.\n'); }
  }
}
const port = Number(process.env.INTAKE_PORT ?? '4341'); if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid INTAKE_PORT.');
intakeServer().listen(port, '127.0.0.1', () => process.stdout.write(`Add your design system: http://127.0.0.1:${port}/\n`));
