import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { audit } from '../src/engine.js';
import { exportVisualReport } from '../src/report.js';
import { createCaptureDirectory, readBaseline, readInput } from '../src/io.js';
import { captureLocal } from '../src/capture.js';

const root = process.cwd();
const cli = join(root, 'dist/src/report-cli.js');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const runCLI = (args: string[]) => spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: 'utf8', timeout: 15000 });
async function temporary() { await mkdir(join(root, 'reports'), { recursive: true }); return mkdtemp(join(root, 'reports/report-test-')); }

test('visual export preserves engine JSON, escapes hostile titles and includes saved sources', async () => {
  const folder = await temporary();
  try {
    const output = relative(root, join(folder, 'bundle'));
    const title = '</script><img src=https://invalid.example onerror=alert(1)>';
    const report = await exportVisualReport('fixtures/seeded.json', output, title);
    assert.deepEqual(report, audit(await readInput('fixtures/seeded.json')));
    assert.deepEqual(JSON.parse(await readFile(join(root, output, 'report.json'), 'utf8')), report);
    const html = await readFile(join(root, output, 'index.html'), 'utf8');
    assert.ok(!html.includes(title)); assert.ok(html.includes('Content-Security-Policy'));
    assert.ok(!html.includes('Direction contract')); assert.ok(!html.includes('FINISH:'));
    const data = JSON.parse(html.match(/<script id="audit-data" type="application\/json">(.*?)<\/script>/s)![1]!);
    assert.equal(data.title, title); assert.deepEqual(data.report, report);
    const source = report.baseline.sources[0]!;
    assert.equal(sha(await readFile(join(root, output, data.sources[0].file))), source.sha256);
    assert.equal(report.outcome, 'mismatches');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('visual export refuses unsafe destinations, overwrite and changed evidence', async () => {
  const folder = await temporary();
  try {
    const out = relative(root, join(folder, 'bundle'));
    await exportVisualReport('fixtures/correct.json', out);
    for (const bad of [out, 'README.md', 'fixtures/new', 'reports/../outside', '/tmp/report-bundle']) await assert.rejects(exportVisualReport('fixtures/correct.json', bad));
    await symlink(root, join(folder, 'link'));
    await assert.rejects(exportVisualReport('fixtures/correct.json', relative(root, join(folder, 'link/bundle'))));
    const bad = JSON.parse(await readFile(join(root, 'fixtures/correct.json'), 'utf8'));
    bad.baseline.sources[0].sha256 = '0'.repeat(64);
    const input = relative(root, join(folder, 'tampered.json'));
    await writeFile(join(root, input), JSON.stringify(bad));
    await assert.rejects(exportVisualReport(input, relative(root, join(folder, 'bad'))), /digest mismatch/);
    await assert.rejects(exportVisualReport('fixtures/correct.json', 'reports/new', ''), /title/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('visual CLI preserves comparison exit codes and rejects malformed arguments', async () => {
  const folder = await temporary();
  try {
    for (const [fixture, code] of [['correct', 3], ['seeded', 1]] as const) {
      const result = runCLI(['--input', `fixtures/${fixture}.json`, '--out', relative(root, join(folder, fixture))]);
      assert.equal(result.status, code, result.stderr); assert.match(result.stdout, /index.html/); assert.match(result.stderr, /SYNTHETIC/);
    }
    assert.equal(runCLI(['--help']).status, 0);
    for (const args of [[], ['--input', 'fixtures/correct.json'], ['--unknown', 'x'], ['--out', 'reports/new', '--out', 'reports/again']]) assert.equal(runCLI(args).status, 2);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('offline report interactions use verified capture geometry, statuses and responsive layouts', { timeout: 90000 }, async t => {
  const folder = await temporary();
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><script>document.documentElement.dataset.theme=localStorage.getItem('theme-v2')||'dark'</script><style>
      *{box-sizing:border-box}body{margin:0;background:#0b0c0d;color:white;font-family:Arial}:root[data-theme=light] body{background:#f4f5f6;color:#111}
      h1.display{font-size:70px;margin:0}.rail{width:300px;height:20px}.g12{display:grid;grid-template-columns:repeat(12,1fr);gap:24px;height:10px}.sec{border-bottom:1px solid gray;height:30px}.space{height:1400px}
      @media(max-width:820px){.g12{display:block}}</style></head><body><div class=rail>Rail</div><h1 class=display>Controlled drift</h1><div class=g12></div><section class=sec>Top</section><div class=space></div><section class=sec>Below fold</section></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM ?? chromium.executablePath() });
    const outputPath = relative(root, join(folder, 'capture'));
    const input = await captureLocal(browser, await readBaseline('baselines/synthetic-first-five.json'), { url: `http://127.0.0.1:${(server.address() as { port: number }).port}/`, widths: [390, 1440], themes: ['dark', 'light'], height: 900, outputPath, outputDirectory: await createCaptureDirectory(outputPath), maxDocumentHeight: 5000 });
    const duplicate = structuredClone(input.runs.find(run => run.theme === 'dark' && run.viewport.width === 1440)!);
    duplicate.id += '-second'; input.runs.push(duplicate);
    const inputName = relative(root, join(folder, 'observations.json'));
    await writeFile(join(root, inputName), JSON.stringify(input));
    const out = relative(root, join(folder, 'visual'));
    const report = await exportVisualReport(inputName, out, 'Controlled fixture');
    assert.deepEqual(report, audit(await readInput(inputName)));
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, offline: true });
    const page = await context.newPage(); const errors: string[] = []; const external: string[] = [];
    page.on('pageerror', error => errors.push(error.message)); page.on('request', request => { if (/^(https?|wss?):/.test(request.url())) external.push(request.url()); });
    await page.goto(pathToFileURL(join(root, out, 'index.html')).href); await page.locator('#highlight').waitFor({ state: 'visible' });
    await t.test('offline first finding and copied screenshots preserve exact report and geometry', async () => {
      assert.equal(await page.locator('#outcome').textContent(), 'Mismatches found');
      assert.equal(await page.locator('#theme').inputValue(), 'dark'); assert.equal(await page.locator('#width').inputValue(), '1440');
      assert.match(await page.locator('#details').innerText(), /106\.56 px/);
      const finding = report.findings.find(f => f.runId === input.runs.find(r => r.theme === 'dark' && r.viewport.width === 1440)!.id && f.ruleId === 'TYPE-DISPLAY')!;
      const obs = input.runs.find(r => r.id === finding.runId)!.observations.find(o => o.ruleId === finding.ruleId)!;
      const geometry = await page.locator('#highlight').evaluate(el => ({ left: parseFloat((el as HTMLElement).style.left), top: parseFloat((el as HTMLElement).style.top) }));
      const shot = input.runs.find(r => r.id === finding.runId)!.capture!.screenshot!;
      assert.ok(Math.abs(geometry.left - obs.position!.x / shot.width * 100) < .0001);
      assert.ok(Math.abs(geometry.top - obs.position!.y / shot.height * 100) < .0001);
      assert.equal(sha(await readFile(join(root, out, 'assets/capture-0.png'))), input.runs[0]!.capture!.screenshot!.sha256);
      assert.ok((await page.locator('#saved-evidence').innerText()).includes(input.runs[0]!.pageUrl));
      assert.deepEqual(external, []); assert.deepEqual(errors, []);
    });
    await t.test('below-fold instance selection, keyboard focus and zoom remain connected', async () => {
      await page.locator('#run').selectOption(input.runs.at(-1)!.id);
      assert.match(await page.locator('#saved-evidence').innerText(), /second/);
      await page.getByRole('button', { name: /Section border/ }).click();
      const instance = page.getByRole('button', { name: '.sec[match=2] · Match', exact: true }); await instance.click();
      assert.ok(await page.locator('#evidence').evaluate(el => el.scrollTop) > 100);
      assert.equal(await instance.evaluate(el => document.activeElement === el), true);
      await page.getByRole('button', { name: 'Actual size', exact: true }).click();
      assert.equal(await page.locator('#zoom').getAttribute('aria-pressed'), 'true');
      await page.getByRole('button', { name: 'Fit width', exact: true }).click();
      assert.equal(await page.locator('#zoom').getAttribute('aria-pressed'), 'false');
    });
    await t.test('theme, responsive applicability, empty search and all eight status filters work', async () => {
      await page.locator('#theme').selectOption('light'); await page.locator('#width').selectOption('390');
      assert.match(await page.locator('#image-status').innerText(), /light.*390/);
      await page.locator('#status').selectOption('not-applicable');
      assert.match(await page.locator('#list-count').innerText(), /^2 of/);
      assert.equal(await page.locator('#highlight').isVisible(), false); assert.equal(await page.locator('#locate').isDisabled(), true);
      await page.locator('#status').selectOption('all'); await page.locator('#search').fill('no-such-rule');
      assert.match(await page.locator('#details').innerText(), /No findings match/);
      assert.equal(await page.locator('#highlight').isVisible(), false);
      assert.equal(await page.locator('#status option').count(), 9); await page.locator('#search').fill('');
      await page.setViewportSize({ width: 390, height: 844 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      await page.setViewportSize({ width: 819, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    });
    await t.test('missing screenshot after export is explicit and disables location/zoom', async () => {
      const imagePath = await page.locator('#capture-image').getAttribute('src');
      await rm(join(root, out, imagePath!)); await page.reload();
      await page.locator('#theme').selectOption('light'); await page.locator('#width').selectOption('390');
      await page.locator('#no-image').waitFor({ state: 'visible' });
      assert.match(await page.locator('#no-image').innerText(), /could not be loaded/);
      assert.equal(await page.locator('#locate').isDisabled(), true); assert.equal(await page.locator('#zoom').isDisabled(), true);
    });
    await t.test('synthetic coverage gaps retain labels and never invent screenshot evidence', async () => {
      const synthetic = relative(root, join(folder, 'synthetic'));
      const gaps = await exportVisualReport('fixtures/coverage-gaps.json', synthetic, '<script>alert(1)</script>');
      await page.goto(pathToFileURL(join(root, synthetic, 'index.html')).href);
      assert.match(await page.locator('#evidence-kind').innerText(), /Synthetic fixture evidence/);
      assert.match(await page.locator('#page-title').innerText(), /<script>/);
      assert.equal(await page.locator('#highlight').isVisible(), false);
      for (const status of ['unchecked', 'missing-guidance', 'ambiguous', 'proposed', 'deferred'] as const) {
        assert.ok(gaps.summary.counts[status] > 0);
        await page.locator('#status').selectOption(status);
        assert.match(await page.locator('#details').innerText(), new RegExp(statusNamesForTest(status)));
      }
      assert.deepEqual(errors, []); assert.deepEqual(external, []);
    });
    await context.close();
  } finally { await browser?.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(folder, { recursive: true, force: true }); }
});
function statusNamesForTest(status: string): string { return ({ unchecked: 'Unchecked', 'missing-guidance': 'Missing guidance', ambiguous: 'Ambiguous', proposed: 'Proposed', deferred: 'Deferred' } as Record<string, string>)[status]!; }
