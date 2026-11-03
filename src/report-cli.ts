import { pathToFileURL } from 'node:url';
import { exitCode, summary } from './cli.js';
import { exportVisualReport } from './report.js';

const usage = `AI Auditor - offline visual report
Usage: node dist/src/report-cli.js --input reports/capture/observations.json --out reports/visual-report [--title "Portfolio home"]

Reads verified saved observations and source/PNG evidence inside the workspace.
Creates a NEW reports/ folder with index.html, report.json, provenance and local assets.
Open index.html directly. Keep the folder together when copying it.
No browser capture, network requests, dependency installation or source edits.
Exit codes: 0 checked declared scope, 1 mismatches, 2 input/I/O error, 3 incomplete coverage.
`;
async function main(args: string[]): Promise<number> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) { process.stdout.write(usage); return 0; }
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]!; const value = args[index + 1];
    if (!['--input', '--out', '--title'].includes(key) || options.has(key) || !value || value.startsWith('--')) throw new Error(usage);
    options.set(key, value);
  }
  if (!options.get('--input') || !options.get('--out')) throw new Error(usage);
  const report = await exportVisualReport(options.get('--input')!, options.get('--out')!, options.get('--title'));
  process.stdout.write(`${options.get('--out')}/index.html\n`);
  process.stderr.write(summary(report) + '\n');
  return exitCode(report);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await main(process.argv.slice(2)); }
  catch (error) { process.stderr.write(`AI Auditor report error: ${JSON.stringify(error instanceof Error ? error.message : 'Unknown error')}\n`); process.exitCode = 2; }
}
