import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { captureLocal } from './capture.js';
import { captureTarget, CORE_WIDTHS } from './capture-policy.js';
import { audit } from './engine.js';
import { createCaptureDirectory, readBaseline, readInput } from './io.js';
import { exitCode, summary } from './cli.js';

const usage = `AI Auditor - local Chromium capture
Usage: node dist/src/capture-cli.js --url http://127.0.0.1:4321/ --baseline baselines/synthetic-visual.json --out reports/capture-name [--widths 390,1440]

Captures both themes. Default widths: ${CORE_WIDTHS.join(',')} CSS px, height 900, pixel ratio 1.
The selected page and same-origin GET/HEAD assets are allowed. Other navigations,
requests, WebSockets, service workers and downloads are blocked or disabled.
The output directory must be new. Browser executable: CHROMIUM or the installed
Playwright Chromium cache. No browser download is performed by this command.
Exit codes match the comparison CLI: 0 declared scope, 1 mismatch, 2 command error, 3 incomplete.
`;
try {
  const args = process.argv.slice(2);
  if (args.length === 1 && ['--help', '-h'].includes(args[0]!)) process.stdout.write(usage);
  else {
    const options = new Map<string, string>();
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i]!; const value = args[i + 1];
      if (!['--url', '--baseline', '--out', '--widths'].includes(key) || options.has(key) || !value || value.startsWith('--')) throw new Error(usage);
      options.set(key, value);
    }
    if (!options.has('--url') || !options.has('--baseline') || !options.has('--out')) throw new Error(usage);
    const target = captureTarget(options.get('--url')!);
    const baseline = await readBaseline(options.get('--baseline')!);
    const widths = options.has('--widths') ? options.get('--widths')!.split(',').map(value => Number(value)) : [...CORE_WIDTHS];
    const outputPath = options.get('--out')!;
    const outputDirectory = await createCaptureDirectory(outputPath);
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM ?? chromium.executablePath() });
    try {
      const input = await captureLocal(browser, baseline, { url: target.href, widths, themes: ['dark', 'light'], height: 900, outputPath, outputDirectory, onProgress: run => process.stderr.write(`${run.id}: ${run.status}${run.reason ? ` - ${run.reason}` : ''}\n`) });
      const inputPath = `${outputPath}/observations.json`;
      await writeFile(join(outputDirectory, 'observations.json'), JSON.stringify(input, null, 2) + '\n', { flag: 'wx' });
      const verified = await readInput(inputPath);
      const report = audit(verified);
      await writeFile(join(outputDirectory, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
      process.stdout.write(`${summary(report)}\nSaved ${outputPath}/report.json\n`);
      process.exitCode = exitCode(report);
    } finally { await browser.close(); }
  }
} catch (error) {
  process.stderr.write(`Capture error: ${JSON.stringify(error instanceof Error ? error.message : 'Unknown failure')}\n`);
  process.exitCode = 2;
}
