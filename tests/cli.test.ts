import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AuditInput, AuditReport } from '../src/contracts.js';

const root = fileURLToPath(new URL('../../', import.meta.url));
const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function run(args: string[]) { return spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 10000 }); }

test('CLI integration: JSON stdout, partial/mismatch/restored outcomes and explicit exit codes', () => {
  const correct = run(['--input', 'fixtures/correct.json']);
  assert.equal(correct.status, 3); assert.match(correct.stderr, /SYNTHETIC.*incomplete/);
  const report = JSON.parse(correct.stdout) as AuditReport;
  assert.equal(report.summary.counts.pass, 10);
  const seeded = run(['--input', 'fixtures/seeded.json']);
  assert.equal(seeded.status, 1); assert.equal((JSON.parse(seeded.stdout) as AuditReport).summary.counts.mismatch, 1);
  const restored = run(['--input', 'fixtures/restored.json']);
  assert.equal(restored.status, 3); assert.deepEqual(JSON.parse(restored.stdout), report);
  assert.equal(run(['--help']).status, 0);
  assert.equal(run(['--input', 'fixtures/correct.json', '--input', 'fixtures/seeded.json']).status, 2);
  assert.equal(run(['--unknown', 'x']).status, 2);
});

test('CLI integration: validates snapshot integrity and safely writes only new report files', async () => {
  await mkdir(join(root, 'reports'), { recursive: true });
  const temporary = await mkdtemp(join(root, 'reports/cli-test-'));
  const local = (name: string) => relative(root, join(temporary, name));
  try {
    const output = local('result.json');
    const saved = run(['--input', 'fixtures/correct.json', '--out', output]);
    assert.equal(saved.status, 3); assert.equal(saved.stdout, '');
    const bytes = await readFile(join(root, output), 'utf8');
    assert.equal((JSON.parse(bytes) as AuditReport).summary.counts.pass, 10);
    assert.equal(run(['--input', 'fixtures/seeded.json', '--out', output]).status, 2);
    assert.equal(await readFile(join(root, output), 'utf8'), bytes);
    for (const bad of ['README.md', 'fixtures/replaced.json', 'reports/../README.md', '/tmp/auditor.json']) assert.equal(run(['--input', 'fixtures/correct.json', '--out', bad]).status, 2);
    const input = JSON.parse(await readFile(join(root, 'fixtures/correct.json'), 'utf8')) as AuditInput;
    input.baseline.sources[0]!.sha256 = '0'.repeat(64);
    await writeFile(join(temporary, 'tampered.json'), JSON.stringify(input));
    assert.equal(run(['--input', local('tampered.json')]).status, 2);
    assert.match(run(['--input', local('tampered.json')]).stderr, /digest mismatch/);
    input.baseline.sources[0]!.snapshot = '../outside.txt';
    await writeFile(join(temporary, 'traversal.json'), JSON.stringify(input));
    assert.equal(run(['--input', local('traversal.json')]).status, 2);
    await symlink(root, join(temporary, 'link'));
    assert.equal(run(['--input', 'fixtures/correct.json', '--out', local('link/no-write.json')]).status, 2);
    await writeFile(join(temporary, 'invalid.json'), '{not JSON}');
    assert.equal(run(['--input', local('invalid.json')]).status, 2);
  } finally { await rm(temporary, { recursive: true, force: true }); }
});
