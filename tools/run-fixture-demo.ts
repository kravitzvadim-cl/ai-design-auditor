import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { audit } from '../src/engine.js';
import { readInput } from '../src/io.js';
import { exitCode, summary } from '../src/cli.js';

const output = 'output/slice-1';
await mkdir(output, { recursive: true });
const results = [];
for (const name of ['correct', 'seeded', 'restored', 'coverage-gaps']) {
  const report = audit(await readInput(`fixtures/${name}.json`));
  // This development evidence command refreshes only its four fixed demonstration artifacts.
  await writeFile(join(output, `${name}.report.json`), JSON.stringify(report, null, 2) + '\n');
  results.push({ fixture: `fixtures/${name}.json`, report: `${output}/${name}.report.json`, outcome: report.outcome, exitCode: exitCode(report), counts: report.summary.counts, reportId: report.id });
  console.log(`${name}: ${summary(report)}`);
}
await writeFile(join(output, 'demo-results.json'), JSON.stringify({ evidenceKind: 'synthetic', results }, null, 2) + '\n');
