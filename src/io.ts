import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AuditInput, AuditReport } from './contracts.js';
import { validateInput } from './validation.js';

function parts(name: string): string[] {
  const parts = name.split(/[\\/]/);
  if (isAbsolute(name) || parts.some(part => !part || part === '.' || part === '..')) throw new Error('Use a relative workspace path without traversal.');
  return parts;
}
function contained(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return suffix !== '' && !isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith(`..${sep}`);
}
export async function readWorkspaceFile(name: string, directory = process.cwd(), maximumBytes = 5_000_000): Promise<Buffer> {
  const root = await realpath(directory);
  parts(name);
  const path = await realpath(resolve(root, name));
  if (!contained(root, path)) throw new Error('Input or snapshot resolves outside the workspace.');
  const info = await lstat(path);
  if (!info.isFile() || info.size > maximumBytes) throw new Error(`Expected a file no larger than ${maximumBytes} bytes.`);
  return readFile(path);
}
async function verifySources(input: AuditInput, directory: string): Promise<void> {
  for (const source of input.baseline.sources) {
    const digest = createHash('sha256').update(await readWorkspaceFile(source.snapshot, directory)).digest('hex');
    if (digest !== source.sha256) throw new Error(`Source snapshot digest mismatch for ${JSON.stringify(source.id)}.`);
  }
}
export async function readBaseline(name: string, directory = process.cwd()): Promise<AuditInput['baseline']> {
  const baseline: unknown = JSON.parse((await readWorkspaceFile(name, directory)).toString('utf8'));
  const input = validateInput({ schemaVersion: '1.2', evidenceKind: 'synthetic', baseline, runs: [{ id: 'validation-only', pageUrl: 'http://127.0.0.1/', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, theme: 'dark', status: 'captured', observations: [] }] });
  await verifySources(input, directory);
  return input.baseline;
}
export async function readInput(name: string, directory = process.cwd()): Promise<AuditInput> {
  const input = validateInput(JSON.parse((await readWorkspaceFile(name, directory, 25_000_000)).toString('utf8')) as unknown);
  await verifySources(input, directory);
  for (const run of input.runs) {
    const image = run.capture?.screenshot;
    if (!image) continue;
    const bytes = await readWorkspaceFile(image.path, directory, 25_000_000);
    if (createHash('sha256').update(bytes).digest('hex') !== image.sha256) throw new Error('Screenshot digest mismatch.');
    if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== image.width || bytes.readUInt32BE(20) !== image.height) throw new Error('Screenshot PNG dimensions do not match provenance.');
  }
  return input;
}
/** Reserve a new capture directory. Existing files/directories and symlink parents are refused. */
export async function createCaptureDirectory(name: string, directory = process.cwd()): Promise<string> {
  const segments = parts(name);
  if (segments.length < 2 || segments[0] !== 'reports') throw new Error('Capture artifacts must be under a new reports/ directory.');
  let current = await realpath(directory);
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    try { await mkdir(current); } catch (error) {
      if (index === segments.length - 1 || !(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if ((await lstat(current)).isSymbolicLink() || !(await lstat(current)).isDirectory()) throw new Error('Capture directories cannot be symlinks.');
  }
  return current;
}
export async function writeReport(name: string, report: AuditReport, directory = process.cwd()): Promise<void> {
  const segments = parts(name);
  if (segments.length < 2 || segments[0] !== 'reports' || !segments.at(-1)!.endsWith('.json')) throw new Error('Reports must be JSON files under reports/.');
  const root = await realpath(directory);
  let parent = root;
  for (const segment of segments.slice(0, -1)) {
    parent = join(parent, segment);
    try { await mkdir(parent); } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error;
    }
    if ((await lstat(parent)).isSymbolicLink() || !(await lstat(parent)).isDirectory() || !contained(root, await realpath(parent))) throw new Error('Report directories must be ordinary workspace directories.');
  }
  // Exclusive create also refuses existing files and final-component symlinks.
  await writeFile(join(parent, segments.at(-1)!), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
}
