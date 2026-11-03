import { pathToFileURL } from 'node:url';
import { audit } from './engine.js';
import type { AuditReport } from './contracts.js';
import { readInput, writeReport } from './io.js';

const usage = `AI Auditor - saved-observation comparison
Usage: node dist/src/cli.js --input fixtures/correct.json [--out reports/run.json]

Input and source snapshots must be inside the current workspace.
Without --out, JSON goes to stdout. Summaries go to stderr.
Report files are created under reports/ and never overwrite an existing file.
Exit codes: 0 checked declared scope, 1 mismatches, 2 input/I/O error,
            3 incomplete coverage (including a partial baseline).
No network requests or browser capture are performed.
`;
export function exitCode(report: AuditReport): number {
  return report.outcome === 'mismatches' ? 1 : report.outcome === 'incomplete' ? 3 : 0;
}
export function summary(report: AuditReport): string {
  const counts = report.summary.counts;
  return `${report.evidenceKind === 'synthetic' ? 'SYNTHETIC' : 'LOCAL CAPTURE'} | ${report.outcome} | ${counts.pass} passed, ${counts.mismatch} mismatches, ${counts.unchecked} unchecked, ${counts['missing-guidance']} missing, ${counts.ambiguous} ambiguous, ${counts.proposed} proposed, ${counts.deferred} deferred, ${counts['not-applicable']} not applicable.${report.evidenceKind === 'synthetic' ? ' Not a portfolio audit.' : ' Partial rule coverage.'}`;
}
async function main(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { process.stdout.write(usage); return 0; }
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]!; const value = args[i + 1];
    if (!['--input', '--out'].includes(key) || options.has(key) || !value || value.startsWith('--')) throw new Error(usage);
    options.set(key, value);
  }
  const inputFile = options.get('--input');
  if (!inputFile) throw new Error(usage);
  const report = audit(await readInput(inputFile));
  const output = options.get('--out');
  if (output) await writeReport(output, report);
  else process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  process.stderr.write(summary(report) + '\n');
  return exitCode(report);
}
// Keep imports side-effect free for tests and the demonstration runner.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write(`AI Auditor error: ${JSON.stringify(message)}\n`);
    process.exitCode = 2;
  }
}
