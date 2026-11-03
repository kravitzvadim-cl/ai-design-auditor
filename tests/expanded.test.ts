import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import type { AuditInput, Expectation } from '../src/contracts.js';
import { normalizeObserved, normalizePixels, resolveExpected } from '../src/normalize.js';
import { audit } from '../src/engine.js';
import { validateInput } from '../src/validation.js';
import { createCaptureDirectory, readBaseline, readInput } from '../src/io.js';
import { captureLocal } from '../src/capture.js';
import { exportVisualReport } from '../src/report.js';

const root = process.cwd();
test('expanded normalization preserves exact decimal math, negative tracking, aliases and maximum semantics', async () => {
  assert.equal(normalizePixels('-4px'), null);
  assert.deepEqual(normalizeObserved('-4px', { kind: 'font-relative', factor: -.04, fontSize: { kind: 'px', value: 100 } }), { kind: 'px', value: -4 });
  assert.deepEqual(resolveExpected({ kind: 'font-relative', factor: .95, fontSize: { kind: 'clamp-vw', min: 44, vw: 7.4, max: 108 } }, 'dark', 1079), { kind: 'px', value: 75.8537 });
  const family: Expectation = { kind: 'font-family', value: 'Instrument Sans', aliases: ['Instrument Sans Variable'] };
  assert.deepEqual(normalizeObserved('"Instrument Sans Variable", Arial, sans-serif', family), { kind: 'text', value: 'instrument sans' });
  assert.deepEqual(normalizeObserved('Arial, "Instrument Sans"', family), { kind: 'text', value: 'arial' });
  const base = JSON.parse(await readFile('fixtures/correct.json', 'utf8')) as AuditInput;
  base.schemaVersion = '1.2'; base.baseline.rules = [base.baseline.rules[0]!];
  const rule = base.baseline.rules[0]!; rule.property = 'width'; rule.expectation = { kind: 'max-px', value: 1080 };
  for (const run of base.runs) run.observations = [{ ruleId: rule.id, element: 'content', state: 'measured', value: '900px' }];
  assert.equal(audit(base).summary.counts.mismatch, 0);
  base.runs[0]!.observations[0]!.value = '1081px'; assert.equal(audit(base).summary.counts.mismatch, 1);
});

test('new contract kinds are versioned and invalid CSS/context data is rejected', async () => {
  const baseline = await readBaseline('baselines/synthetic-expanded.json');
  const input = { schemaVersion: '1.2', evidenceKind: 'synthetic', baseline, runs: [{ id: 'test', pageUrl: 'http://127.0.0.1/', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, theme: 'dark', status: 'captured', observations: [] }] };
  validateInput(input);
  assert.throws(() => validateInput({ ...input, schemaVersion: '1.1' }), /require schema 1.2/);
  for (const invalid of [{ kind: 'keyword', value: 'url(https://invalid.example/)' }, { kind: 'font-family', value: 'Arial; color:red' }, { kind: 'font-relative', factor: .95, fontSize: { kind: 'keyword', value: 'inherit' } }]) {
    const copy = structuredClone(input); copy.baseline.rules[0]!.expectation = invalid as Expectation;
    assert.throws(() => validateInput(copy));
  }
  for (const width of [819, 820, 821]) {
    const expected = width <= 820 ? 32 : 40;
    const candidates = baseline.rules.filter(rule => rule.id.startsWith('SPACE-ROW-TOP') && (!rule.condition?.maxWidth || width <= rule.condition.maxWidth) && (rule.condition?.minWidthExclusive === undefined || width > rule.condition.minWidthExclusive));
    assert.equal(candidates.length, 1); assert.deepEqual(candidates[0]!.expectation, { kind: 'px', value: expected });
    assert.equal(candidates[0]!.source!.id, 'synthetic-responsive-rules');
  }
});

test('documented visual scope rejects guidance, unsupported and nonvisual rules', async () => {
  const baseline = await readBaseline('baselines/synthetic-visual.json');
  const input = { schemaVersion: '1.2', evidenceKind: 'synthetic', baseline, runs: [{ id: 'test', pageUrl: 'http://127.0.0.1/', viewport: { width: 1440, height: 900, deviceScaleFactor: 1 }, theme: 'dark', status: 'captured', observations: [] }] };
  assert.equal(baseline.rules.length, 81); validateInput(input);
  const simple = await readBaseline('baselines/synthetic-text.json');
  assert.equal(simple.rules.length, 15);
  assert.ok(simple.rules.every(rule => ['font-size', 'color'].includes(rule.property!)));
  assert.ok(!simple.rules.some(rule => /LINE|TRACK|WEIGHT/.test(rule.id)));
  for (const patch of [{ status: 'missing-guidance', reason: 'Not documented' }, { expectation: { kind: 'unsupported', expression: 'Unknown relationship' } }, { property: 'performance-score' }]) {
    const invalid = structuredClone(input); Object.assign(invalid.baseline.rules[0]!, patch);
    assert.throws(() => validateInput(invalid), /documented visual scope/);
  }
});

test('expanded Chromium references use independent source font context and retain old capture contracts', { timeout: 90000 }, async t => {
  await mkdir('reports', { recursive: true }); const folder = await mkdtemp(join(root, 'reports/expanded-test-'));
  const server = createServer((request, response) => {
    const drift = request.url === '/drift';
    response.setHeader('Content-Type', 'text/html'); response.end(`<!doctype html><html><head><script>document.documentElement.dataset.theme=localStorage.getItem('theme-v2')||'dark'</script><style>
      *{box-sizing:border-box}body{margin:0;font-family:Arial}h1{font-family:'Instrument Sans Variable',sans-serif;font-size:${drift ? '63px' : 'clamp(44px,7.4vw,108px)'};font-weight:${drift ? '400' : '700'};line-height:.95;letter-spacing:-.055em;text-wrap:balance;margin:0}.box{width:100%;max-width:${drift ? 1100 : 900}px;border-radius:${drift ? 9 : 4}px;box-shadow:none;border-top:${drift ? 3 : 1}px solid gray;padding-top:${drift ? 6 : 40}px}
      @media(max-width:820px){.box{padding-top:32px}}${request.url === '/hidden' ? 'h1{display:none}' : ''}</style></head><body><h1>Independent context</h1><div class=box>Box</div></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve)); let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM ?? chromium.executablePath() });
    const baseline = await readBaseline('baselines/synthetic-expanded.json');
    const ids = ['TYPE-DISPLAY-FAMILY', 'TYPE-DISPLAY-WEIGHT', 'TYPE-DISPLAY-SIZE', 'TYPE-DISPLAY-LINE', 'TYPE-DISPLAY-TRACK', 'TYPE-HEAD-WRAP', 'LAYOUT-CONTENT-CAP', 'SPACE-ROW-TOP-WIDE', 'SPACE-ROW-TOP-NARROW', 'SHAPE-THEME-TOP-LEFT', 'SHADOW-STRUCTURE', 'BORDER-LINK'];
    baseline.rules = baseline.rules.filter(rule => ids.includes(rule.id));
    for (const rule of baseline.rules) rule.selector = rule.id.startsWith('TYPE-') ? 'h1' : '.box';
    const capture = async (name: string, route: string, widths = [390, 819, 820, 821, 1079, 1080, 1081, 1440, 1920]) => {
      const outputPath = relative(root, join(folder, name));
      return captureLocal(browser!, baseline, { url: `http://127.0.0.1:${(server.address() as { port: number }).port}${route}`, widths, themes: ['dark', 'light'], height: 900, outputPath, outputDirectory: await createCaptureDirectory(outputPath) });
    };
    const correct = await capture('correct', '/');
    await t.test('all nine boundary widths and both themes compare correctly without a tolerance', () => {
      assert.equal(correct.schemaVersion, '1.2');
      assert.ok(correct.runs.every(run => run.status === 'captured'), JSON.stringify(correct.runs.map(run => run.reason)));
      const report = audit(correct); assert.equal(report.summary.counts.mismatch, 0, JSON.stringify(report.findings.filter(f => f.status === 'mismatch')));
      assert.equal(report.summary.counts.unchecked, 0);
      assert.ok(correct.runs.every(run => run.capture!.measurement === 'browser-reference-v2'));
    });
    await t.test('font drift cannot hide line-height or tracking drift; restoration clears it', async () => {
      const drift = audit(await capture('drift', '/drift', [1440]));
      for (const id of ['TYPE-DISPLAY-WEIGHT', 'TYPE-DISPLAY-SIZE', 'TYPE-DISPLAY-LINE', 'TYPE-DISPLAY-TRACK', 'LAYOUT-CONTENT-CAP', 'SPACE-ROW-TOP-WIDE', 'BORDER-LINK']) assert.ok(drift.findings.some(f => f.ruleId === id && f.status === 'mismatch'), id);
      assert.equal(audit(await capture('restored', '/', [1440])).summary.counts.mismatch, 0);
    });
    await t.test('hidden elements have no screenshot highlight or location action', async () => {
      const hidden = await capture('hidden', '/hidden', [1440]);
      const scoped = structuredClone(hidden); scoped.baseline.scope = 'documented-visual';
      assert.equal(audit(scoped).summary.counts.unchecked, 0);
      assert.ok(audit(scoped).findings.some(item => item.status === 'not-applicable' && /hidden/.test(item.reason)));
      const failure = structuredClone(scoped);
      failure.runs[0]!.observations.find(item => item.state === 'unsupported')!.reason = 'Font could not be measured.';
      assert.equal(audit(failure).summary.counts.unchecked, 1, 'Measurement failures must remain visible.');
      const file = relative(root, join(folder, 'hidden.json')); await writeFile(join(root, file), JSON.stringify(hidden));
      const output = relative(root, join(folder, 'hidden-report')); await exportVisualReport(file, output);
      const page = await browser!.newPage(); await page.goto(pathToFileURL(join(root, output, 'index.html')).href);
      await page.locator('#search').fill('TYPE-DISPLAY-SIZE');
      assert.equal(await page.locator('#highlight').isVisible(), false); assert.equal(await page.locator('#locate').isDisabled(), true);
      assert.match(await page.locator('#details').innerText(), /No measured bounds|not rendered/); await page.close();
    });
    await t.test('visual report opens on documented styling mismatches without gap-analysis filters', async () => {
      const input = structuredClone(await capture('visual-drift', '/drift', [1440])); input.baseline.scope = 'documented-visual';
      const file = relative(root, join(folder, 'visual.json')); await writeFile(join(root, file), JSON.stringify(input));
      const output = relative(root, join(folder, 'visual-report')); const report = await exportVisualReport(file, output);
      assert.equal(report.baseline.scope, 'documented-visual');
      const page = await browser!.newPage(); await page.goto(pathToFileURL(join(root, output, 'index.html')).href);
      assert.equal(await page.locator('#status').inputValue(), 'mismatch');
      assert.equal(await page.locator('#status').isVisible(), false);
      assert.equal(await page.locator('label[for=status]').isVisible(), false);
      assert.match(await page.locator('#list-count').innerText(), /design errors? in this view/);
      assert.equal(await page.locator('#status option[value=ambiguous]').count(), 0);
      assert.equal(await page.locator('#status option[value=missing-guidance]').count(), 0);
      assert.match(await page.locator('#audit-meta').innerText(), /Text size and color/);
      assert.equal(await page.locator('#details .values > div').count(), 2);
      const comparison = await page.locator('#details').boundingBox(); const evidence = await page.locator('#evidence').boundingBox();
      assert.ok(comparison && evidence && comparison.y < evidence.y, 'Compare values before inspecting the screenshot.');
      const nextLocation = page.getByRole('button', { name: 'Next affected location' });
      if (await nextLocation.count()) { await nextLocation.focus(); await nextLocation.press('Enter'); assert.equal(await nextLocation.evaluate(button => button === document.activeElement), true); }
      await page.locator('#search').fill('TYPE-DISPLAY-FAMILY');
      assert.equal(await page.locator('.finding').count(), 0, 'Passing styles cannot appear through search.');
      assert.match(await page.locator('#details').innerText(), /No design errors/);
      await page.close();
    });
    await t.test('large report keeps its actionable selected finding visible in the index', async () => {
      const stress = JSON.parse(await readFile('fixtures/correct.json', 'utf8')) as AuditInput;
      const template = stress.baseline.rules[0]!;
      stress.baseline.rules = Array.from({ length: 50 }, (_, index) => ({ ...template, id: `SYNTHETIC-STRESS-${String(index).padStart(2, '0')}`, category: 'typography', property: 'font-size', expectation: { kind: 'px', value: 16 } }));
      stress.runs = stress.runs.slice(0, 1); stress.runs[0]!.observations = stress.baseline.rules.map((rule, index) => ({ ruleId: rule.id, element: '.synthetic', state: 'measured', value: index === 49 ? '17px' : '16px' }));
      const file = relative(root, join(folder, 'stress.json')); await writeFile(join(root, file), JSON.stringify(stress));
      const output = relative(root, join(folder, 'stress-report')); await exportVisualReport(file, output);
      const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(pathToFileURL(join(root, output, 'index.html')).href);
      const active = page.locator('.finding[aria-pressed=true]'); assert.match(await active.innerText(), /SYNTHETIC-STRESS-49/);
      const selectedBox = await active.boundingBox(); const listBox = await page.locator('#findings').boundingBox();
      assert.ok(selectedBox && listBox && selectedBox.y >= listBox.y && selectedBox.y + selectedBox.height <= listBox.y + listBox.height + 1);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true); await page.close();
    });
    await t.test('reference provenance, measurement version and screenshot integrity remain checked', async () => {
      const bad = structuredClone(correct); bad.runs[0]!.capture!.measurement = 'browser-reference-v1'; assert.throws(() => validateInput(bad), /measurement policy/);
      const ref = structuredClone(correct); ref.runs[0]!.observations.find(o => o.ruleId === 'TYPE-DISPLAY-LINE')!.reference!.expression = '.95 * target font size'; assert.throws(() => validateInput(ref), /source-backed expectation/);
      const border = structuredClone(correct); border.runs[0]!.observations.find(o => o.ruleId === 'BORDER-LINK')!.reference!.value = '0px'; assert.throws(() => validateInput(border), /contradicts literal source/);
      const file = relative(root, join(folder, 'input.json')); await writeFile(join(root, file), JSON.stringify(correct));
      await readInput(file);
      const output = relative(root, join(folder, 'report')); await exportVisualReport(file, output);
      const page = await browser!.newPage({ viewport: { width: 390, height: 844 } });
      await page.goto(pathToFileURL(join(root, output, 'index.html')).href); await page.locator('#search').fill('TYPE-DISPLAY-WEIGHT');
      assert.match(await page.locator('#details').innerText(), /700/); assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.locator('#search').fill('LAYOUT-CONTENT-CAP'); assert.match(await page.locator('#details').innerText(), /≤ 1080 px/);
      await page.close();
    });
  } finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(folder, { recursive: true, force: true }); }
});
