import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright-core';
import type { Browser } from 'playwright-core';
import { captureLocal } from '../src/capture.js';
import { captureTarget, diagnosticMessage, requestAllowed } from '../src/capture-policy.js';
import { audit } from '../src/engine.js';
import { createCaptureDirectory, readBaseline, readInput } from '../src/io.js';
import { validateInput } from '../src/validation.js';

const root = process.cwd();
test('capture request policy blocks other origins, navigations, credentials and writes', () => {
  const target = captureTarget('http://127.0.0.1:4321/');
  assert.equal(requestAllowed(target.href, 'GET', true, true, target), true);
  assert.equal(requestAllowed('http://127.0.0.1:4321/font.woff2', 'GET', false, false, target), true);
  for (const [url, method, navigation, main] of [
    ['http://127.0.0.1:4322/font.woff2', 'GET', false, false],
    ['https://example.com/image.png', 'GET', false, false],
    ['http://127.0.0.1:4321/write', 'POST', false, false],
    ['http://127.0.0.1:4321/other-page', 'GET', true, true],
    [target.href, 'GET', true, false],
    ['http://user:password@127.0.0.1:4321/', 'GET', true, true],
  ] as const) assert.equal(requestAllowed(url, method, navigation, main, target), false);
  for (const url of ['http://localhost:4321/', 'http://192.168.1.1/', 'file:///tmp/page.html', target.href + '#hash']) assert.throws(() => captureTarget(url));
  assert.equal(diagnosticMessage('Blocked ws://user:password@127.0.0.1:4321/hmr?token=private#fragment'), 'Blocked ws://127.0.0.1:4321/hmr');
});

test('real Chromium capture pipeline with controlled local fixture servers', { timeout: 90000 }, async t => {
  await mkdir(join(root, 'reports'), { recursive: true });
  const temporary = await mkdtemp(join(root, 'reports/browser-test-'));
  let foreignHits = 0; let foreignConnections = 0; let postHits = 0;
  const foreign = createServer((_request, response) => { foreignHits++; response.end('unexpected'); });
  foreign.on('connection', () => { foreignConnections++; });
  await new Promise<void>(resolve => foreign.listen(0, '127.0.0.1', resolve));
  const foreignPort = (foreign.address() as { port: number }).port;
  const server = createServer((request, response) => {
    if (request.method === 'POST') { postHits++; response.end('unexpected write'); return; }
    if (request.url === '/missing.woff2') { response.writeHead(404); response.end(); return; }
    if (request.url === '/redirect') { response.writeHead(302, { Location: `http://127.0.0.1:${foreignPort}/destination?token=private` }); response.end(); return; }
    const mode = request.url;
    response.setHeader('Content-Type', 'text/html');
    response.end(`<!doctype html><html><head><script>document.documentElement.dataset.theme=localStorage.getItem('theme-v2')||'dark';</script><style>
      :root{--bg:#0b0c0d} :root[data-theme=light]{--bg:#f4f5f6} *{box-sizing:border-box} body{margin:0;background:${mode === '/mismatch' ? '#ff0000' : 'var(--bg)'};font-family:Arial}
      h1.display{font-size:clamp(44px,7.4vw,108px);margin:0} .rail{width:300px;height:20px} .g12{display:grid;grid-template-columns:repeat(12,1fr);gap:24px;height:10px} .sec{height:20px;border-bottom:1px solid gray} .space{height:1100px}
      @media(max-width:820px){.g12{display:block}}
      ${mode === '/bad-font' ? '@font-face{font-family:BrokenCaptureFont;src:url(/missing.woff2)}h1{font-family:BrokenCaptureFont,Arial}' : ''}
      </style></head><body><aside class=rail></aside><h1 class=display>Fixture heading</h1><div class=g12></div><section class=sec></section><div class=space></div><section class=sec></section>
      ${mode === '/blocked' ? `<img src="http://127.0.0.1:${foreignPort}/pixel?token=private"><script>fetch('/write',{method:'POST',body:'test-only'}).catch(()=>{});new WebSocket('ws://127.0.0.1:${foreignPort}/socket?token=private');</script>` : ''}
      </body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM ?? chromium.executablePath() });
    const baseline = await readBaseline('baselines/synthetic-first-five.json');
    const capture = async (name: string, route: string, widths = [1440], themes: ('dark' | 'light')[] = ['dark'], maxDocumentHeight = 5000) => {
      const outputPath = relative(root, join(temporary, name));
      const outputDirectory = await createCaptureDirectory(outputPath);
      const input = await captureLocal(browser!, baseline, { url: `http://127.0.0.1:${port}${route}`, widths, themes, height: 900, outputPath, outputDirectory, maxDocumentHeight, timeoutMs: 6000 });
      await writeFile(join(outputDirectory, 'observations.json'), JSON.stringify(input));
      return { input: await readInput(`${outputPath}/observations.json`), outputDirectory, outputPath };
    };
    const correct = await capture('correct', '/', [390, 821, 1440], ['dark', 'light']);
    await t.test('captures both themes, all matching instances and below-fold evidence with source-derived references', () => {
      assert.equal(correct.input.schemaVersion, '1.1'); assert.equal(correct.input.evidenceKind, 'local-capture');
      const report = audit(correct.input);
      assert.equal(report.summary.counts.pass, 32); assert.equal(report.summary.counts['not-applicable'], 4);
      assert.equal(report.summary.counts.mismatch, 0); assert.equal(report.summary.counts.unchecked, 0);
      for (const run of correct.input.runs) {
        assert.equal(run.status, 'captured'); assert.equal(run.capture!.achievedTheme, run.theme);
        assert.ok(run.capture!.fontsReady); assert.ok(run.capture!.document.height > run.viewport.height);
        assert.equal(run.capture!.screenshot!.height, run.capture!.document.height);
        assert.equal(run.capture!.issues.length, 0);
        assert.equal(run.capture!.enumeration.find(item => item.ruleId === 'BORDER-SECTION')!.matched, 2);
        assert.ok(run.observations.some(obs => obs.position!.y > 900));
        assert.ok(run.observations.every(obs => obs.state !== 'measured' || !!obs.reference));
      }
    });
    await t.test('independent expected CSS catches real DOM drift and restoration clears it', async () => {
      const mismatch = await capture('mismatch', '/mismatch');
      const report = audit(mismatch.input);
      assert.equal(report.summary.counts.mismatch, 1);
      const finding = report.findings.find(finding => finding.status === 'mismatch')!;
      assert.equal(finding.ruleId, 'COLOR-BG');
      assert.deepEqual(finding.expected!.value, [11, 12, 13, 1]);
      assert.deepEqual(finding.actual!.value, [255, 0, 0, 1]);
      const restored = await capture('restored', '/');
      assert.equal(audit(restored.input).summary.counts.mismatch, 0);
    });
    await t.test('bad font readiness yields unchecked coverage instead of false violations', async () => {
      const bad = await capture('bad-font', '/bad-font');
      assert.equal(bad.input.runs[0]!.status, 'failed');
      assert.match(bad.input.runs[0]!.reason!, /font/);
      const report = audit(bad.input);
      assert.equal(report.summary.counts.unchecked, 5); assert.equal(report.summary.checked, 0);
    });
    await t.test('blocked external image/WebSocket and POST never reach their destinations; logs omit query tokens', async () => {
      const blocked = await capture('blocked', '/blocked');
      assert.equal(foreignHits, 0); assert.equal(foreignConnections, 0); assert.equal(postHits, 0);
      assert.ok(blocked.input.runs[0]!.capture!.issues.length > 0);
      assert.ok(!JSON.stringify(blocked.input).includes('token=private'));
      assert.equal(audit(blocked.input).outcome, 'incomplete');
    });
    await t.test('redirects cannot escape the selected origin and route', async () => {
      const redirected = await capture('redirect', '/redirect');
      assert.equal(redirected.input.runs[0]!.status, 'failed');
      assert.equal(foreignHits, 0); assert.equal(foreignConnections, 0); assert.equal(audit(redirected.input).summary.checked, 0);
    });
    await t.test('capture cap is visible and prevents comparison without complete evidence', async () => {
      const capped = await capture('capped', '/', [1440], ['dark'], 500);
      assert.equal(capped.input.runs[0]!.status, 'failed'); assert.match(capped.input.runs[0]!.reason!, /cap/);
      assert.equal(audit(capped.input).summary.counts.unchecked, 5);
    });
    await t.test('metadata/reference/enumeration tampering fails validation; screenshot tampering fails replay', async () => {
      for (const mutate of [
        (input: typeof correct.input) => { input.runs[0]!.capture!.achievedTheme = 'light'; },
        (input: typeof correct.input) => { input.runs[0]!.capture!.screenshot!.width++; },
        (input: typeof correct.input) => { input.runs[0]!.observations[0]!.reference!.expression = '#ff0000'; },
        (input: typeof correct.input) => { input.runs[0]!.capture!.enumeration[0]!.matched++; },
      ]) { const input = structuredClone(correct.input); mutate(input); assert.throws(() => validateInput(input)); }
      const tampered = structuredClone(correct.input);
      tampered.runs[0]!.capture!.screenshot!.sha256 = '0'.repeat(64);
      await writeFile(join(correct.outputDirectory, 'tampered.json'), JSON.stringify(tampered));
      await assert.rejects(readInput(`${correct.outputPath}/tampered.json`), /Screenshot digest/);
      const png = await readFile(join(root, correct.input.runs[0]!.capture!.screenshot!.path));
      assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
    });
  } finally {
    await browser?.close();
    await Promise.all([new Promise<void>(resolve => server.close(() => resolve())), new Promise<void>(resolve => foreign.close(() => resolve()))]);
    await rm(temporary, { recursive: true, force: true });
  }
});
