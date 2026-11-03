import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditReport } from './contracts.js';
import type { VisualData } from './report-model.js';
import { audit } from './engine.js';
import { createCaptureDirectory, readInput, readWorkspaceFile } from './io.js';
import { reportStyle } from './report-style.js';

function escapeHTML(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
function safeJSON(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
const digest = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');

/** Generate an offline bundle from verified observations. The comparison engine is unchanged. */
export async function exportVisualReport(inputName: string, outputName: string, title = 'Local page audit', directory = process.cwd()): Promise<AuditReport> {
  if (!title.trim() || title.length > 200) throw new Error('Report title must contain 1 to 200 characters.');
  const input = await readInput(inputName, directory);
  const report = audit(input);
  const data: VisualData = { title, report, rules: input.baseline.rules, runs: [], locations: {}, sources: [] };
  const assets: { name: string; bytes: Buffer; origin: string; sha256: string }[] = [];
  for (const [index, run] of input.runs.entries()) {
    const shot = run.capture?.screenshot;
    let image: string | null = null;
    if (shot) {
      const bytes = await readWorkspaceFile(shot.path, directory, 25_000_000);
      if (digest(bytes) !== shot.sha256) throw new Error('Screenshot changed while preparing the report.');
      image = `assets/capture-${index}.png`;
      assets.push({ name: image, bytes, origin: shot.path, sha256: shot.sha256 });
    }
    data.runs.push({ id: run.id, pageUrl: run.pageUrl, viewport: run.viewport, theme: run.theme, status: run.status, reason: run.reason ?? null, capture: run.capture ?? null, image });
    for (const finding of report.findings.filter(item => item.runId === run.id)) {
      const observation = run.observations.find(item => item.ruleId === finding.ruleId && item.element === finding.element);
      if (observation?.position && observation.bounds) data.locations[finding.id] = { ...observation.position, ...observation.bounds };
    }
  }
  for (const [index, source] of input.baseline.sources.entries()) {
    const bytes = await readWorkspaceFile(source.snapshot, directory);
    if (digest(bytes) !== source.sha256) throw new Error('Source changed while preparing the report.');
    const file = `sources/source-${index}.txt`;
    data.sources.push({ id: source.id, file });
    assets.push({ name: file, bytes, origin: source.snapshot, sha256: source.sha256 });
  }
  const client = await readFile(new URL('./report-client.js', import.meta.url), 'utf8');
  const scriptHash = createHash('sha256').update(client).digest('base64');
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data: file:; style-src 'unsafe-inline'; script-src 'sha256-${scriptHash}'; base-uri 'none'; form-action 'none'">
<meta name="color-scheme" content="light"><title>${escapeHTML(title)} - AI Auditor</title><style>${reportStyle}</style></head>
<body><a class="skip" href="#report-main">Skip to report</a><header class="header"><div class="brand">AI Auditor <span>Local audit report</span></div><nav aria-label="Saved report files"><a href="report.json" download>Save JSON</a><a href="provenance.json" download>Evidence record</a></nav></header>
<main id="report-main"><div class="heading"><div><h1 id="page-title">${escapeHTML(title)}</h1><p id="audit-meta" class="sub"></p></div><div class="scope"><strong id="outcome" class="badge"></strong><p id="counts"></p></div></div>
<p id="evidence-kind" class="notice" hidden></p><details class="coverage"><summary id="coverage-label">Scope, sources and capture diagnostics</summary><div id="coverage-body"></div></details>
<div class="workspace"><aside class="index" aria-label="Findings"><h2>Findings</h2><div class="filter"><label for="status">Result status</label><select id="status"><option value="all">All statuses</option></select><label for="search">Find rule or element</label><input id="search" type="search" placeholder="Rule, selector or property" autocomplete="off"></div><p id="list-count" class="quiet" role="status" aria-live="polite"></p><div id="findings" class="finding-list"></div><p class="scope-note">A matching result covers the declared rule and tested context. It does not establish whole-page conformance.</p></aside>
<section class="review" aria-label="Finding and screenshot"><div class="toolbar"><h2>Screenshot evidence</h2><div class="controls"><label>Audited theme<select id="theme"></select></label><label>Viewport width<select id="width"></select></label><label id="run-label" hidden>Capture<select id="run"></select></label><button id="locate" type="button">Locate finding</button><button id="zoom" type="button" aria-pressed="false">Actual size</button></div></div>
<p id="image-status" class="image-status" role="status"></p><div id="evidence" class="evidence" tabindex="0" role="region" aria-label="Scrollable screenshot"><div id="canvas" class="canvas"><img id="capture-image" alt="" hidden><div id="highlight" class="highlight" hidden><span id="highlight-label"></span></div></div><p id="no-image" class="no-image"></p></div>
<section id="details" class="details" aria-label="Selected finding details"><p>Select a finding to inspect its values and source.</p></section><p id="saved-evidence" class="saved-evidence"></p></section></div>
<footer><span>Saved evidence. Reviewing this report does not change the audited page.</span><span id="report-id"></span></footer></main>
<noscript><p class="notice">Enable JavaScript to inspect findings and screenshots. The same saved results are available in <a href="report.json">report.json</a>.</p></noscript>
<script id="audit-data" type="application/json">${safeJSON(data)}</script><script type="module">${client}</script></body></html>`;
  // All inputs/assets are preflighted before reserving a new output folder.
  const output = await createCaptureDirectory(outputName, directory);
  for (const sub of ['assets', 'sources']) await mkdir(join(output, sub));
  for (const asset of assets) await writeFile(join(output, asset.name), asset.bytes, { flag: 'wx' });
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'provenance.json'), JSON.stringify({ reportId: report.id, input: inputName, evidenceKind: input.evidenceKind, assets: assets.map(({ bytes: _bytes, ...asset }) => asset), captures: report.captures ?? [], note: 'Screenshots and source snapshots copied byte-for-byte; original hashes retained. No live source refresh or new capture.' }, null, 2) + '\n', { flag: 'wx' });
  await writeFile(join(output, 'index.html'), html, { flag: 'wx' });
  return report;
}
