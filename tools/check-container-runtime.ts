/** Offline probe: no server, real site, upload, API key or model request. */
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inspectWebsite, compareWebsite } from '../src/web-audit.js';
const root = await mkdtemp(join(tmpdir(), 'auditor-capacity-'));
const started = performance.now();
const cgroup = async (file: string) => (await readFile(`/sys/fs/cgroup/${file}`, 'utf8').catch(() => 'unavailable')).trim();
try {
  const memoryLimit = await cgroup('memory.max'), cpuLimit = await cgroup('cpu.max');
  if (memoryLimit !== '536870912' || cpuLimit !== '10000 100000') throw new Error(`Probe requires exactly 512 MiB and 0.1 CPU; got ${memoryLimit}, ${cpuLimit}.`);
  const target = await inspectWebsite('https://example.com/', root, ['light', 'dark'], async url => ({ finalUrl: url, bytes: Buffer.from('<!doctype html><style>p{font-size:18px;color:#333}</style><h1>Controlled sample</h1><p>Body copy</p>'), type: 'text/html' }));
  const ids = target.candidates.filter(c => c.tag === 'p').map(c => c.id);
  const report = compareWebsite(target, [{ id: 'body', name: 'Body', size: '16px', color: '#333', theme: 'all', sourceId: 'manual', evidence: 'Synthetic rule' }], [{ ruleId: 'body', elementIds: ids }]);
  if (target.captures.length !== 4 || report.differences.length !== 1 || report.differences[0]!.locations.length !== 4 || report.unchecked.length) throw new Error('Probe capture/comparison was incomplete.');
  process.stdout.write(JSON.stringify({ probe: 'offline-four-captures', success: true, chromiumSandboxRequested: true, elapsedMS: Math.round(performance.now() - started), memoryPeakBytes: await cgroup('memory.peak'), memoryLimit, cpuLimit, browser: target.browser }) + '\n');
} catch (error) {
  process.stderr.write(JSON.stringify({ probe: 'offline-four-captures', success: false, chromiumSandboxRequested: true, elapsedMS: Math.round(performance.now() - started), memoryPeakBytes: await cgroup('memory.peak'), error: error instanceof Error ? error.message : 'Runtime check failed.' }) + '\n');
  process.exitCode = 1;
} finally { await rm(root, { recursive: true, force: true }); }
