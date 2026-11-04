import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, readdir, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { extractRules, sourceFromText, readAsset, figmaRules, htmlText } from '../src/intake.js';
import { checkedUrl, publicAddress, figmaLocation, readLink } from '../src/intake-network.js';
import { intakeServer } from '../src/intake-server.js';

test('intake extracts explicit text-size/color rules and keeps ambiguous values out', () => {
  const rows = extractRules('Heading: 32px #183b36\nBody | 16px | #444\nUnspecified beautiful large heading\nSizes 32px and 16px\nDark and light #fff #000\nDisplay clamp(44px, 7.4vw, 108px)', 'source');
  assert.equal(rows.length, 2); assert.equal(rows[0]!.name, 'Heading'); assert.equal(rows[0]!.size, '32px');
  assert.ok(rows.every(row => row.sourceId === 'source' && row.theme === 'all'));
  const css = extractRules('h1 { font-size: 2rem; color: #183b36; font-weight:700; }', 'css'); assert.equal(css.length, 1); assert.equal(css[0]!.size, '2rem');
  const json = extractRules(JSON.stringify({ rules: [{ name: 'Body', size: '16px', color: '#333' }] }), 'json'); assert.equal(json[0]!.name, 'Body');
  assert.equal(extractRules(JSON.stringify({ name: 'Body', size: '16px', color: '#333', theme: 'dark' }), 'theme')[0]!.theme, 'dark');
  assert.equal(extractRules(':root { --font-size-body: 16px; --text-color: #333; }', 'variables').length, 2);
  const token = extractRules(JSON.stringify({ body: { $type: 'dimension', $value: { value: 16, unit: 'px' } }, textColor: { $type: 'color', $value: '#333' } }), 'tokens'); assert.ok(token.some(r => r.color === '#333'));
  const unrelated = extractRules('The type scale uses a line height in a multiple of 5px.\nThe tablet breakpoint (640px).\nUse the brand token rather than #1d70b8.\nFor example, blue could be #1d70b8.\nLetter spacing: 2px', 'public-doc');
  assert.deepEqual(unrelated, [], 'Documentation prose must not turn excluded properties or examples into text rules.');
});

test('HTML colour tables preserve row context and only import text roles', () => {
  const html = `<table>
    <tr>
      <th><span style="background-color:#123456"></span>
        <code>text</code></th>
      <td><code>#123456</code></td>
    </tr>
    <tr><th>link</th><td>#216087</td></tr>
    <tr><th>link-hover</th><td>#112233</td></tr>
    <tr><th>body-background</th><td>#ffffff</td></tr>
    <tr><th>primary</th><td>#333333</td></tr>
    <tr><th>Heading</th><td>20px</td></tr>
  </table>`;
  const rules = extractRules(htmlText(html), 'table');
  assert.deepEqual(rules.map(rule => [rule.name, rule.color, rule.size]), [
    ['Body text', '#123456', ''], ['Link', '#216087', ''], ['Heading', '', '20px'],
  ]);
  assert.match(rules[0]!.evidence, /text \| #123456/);
});

test('source readers preserve provenance and treat unknown files honestly', async () => {
  const a = sourceFromText('A', 'Heading 32px #333'); const b = sourceFromText('B', 'Heading 32px #333'); assert.equal(a.sha256, b.sha256); assert.notEqual(a.id, b.id);
  const file = await readAsset('test.css', Buffer.from('h1 { font-size:20px; color:#111; }'), 'text/css'); assert.equal(file.rules.length, 1);
  const unknown = await readAsset('custom.xyz', Buffer.from([0, 1, 2]), 'application/octet-stream'); assert.equal(unknown.rules.length, 0); assert.match(unknown.message, /not been interpreted/);
  await assert.rejects(readAsset('empty.txt', Buffer.from(''), 'text/plain'), /nonempty/);
});

test('public source routing rejects credentials, private networks and malformed Figma links', async () => {
  for (const url of ['file:///tmp/secret', 'http://localhost/', 'http://127.0.0.1/', 'http://[::1]/', 'http://169.254.169.254/', 'https://user:pass@example.com', 'http://example.com:9999/']) assert.throws(() => checkedUrl(url));
  for (const address of ['10.0.0.1', '172.16.0.1', '192.168.1.1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(publicAddress(address), false);
  assert.equal(publicAddress('8.8.8.8'), true);
  assert.deepEqual(figmaLocation('https://www.figma.com/design/abcde/Example?node-id=1-2'), { key: 'abcde', node: '1:2' });
  assert.equal(figmaLocation('https://example.com/file/abcde'), null);
  const old = process.env.FIGMA_ACCESS_TOKEN; delete process.env.FIGMA_ACCESS_TOKEN;
  try { const source = await readLink('https://www.figma.com/design/abcde/Example'); assert.equal(source.state, 'connection-required'); assert.equal(source.rules.length, 0); } finally { if (old !== undefined) process.env.FIGMA_ACCESS_TOKEN = old; }
});

test('Figma reader uses structured text values and skips mixed text styles', () => {
  const text = { type: 'TEXT', id: '1:2', name: 'Heading', style: { fontSize: 32 }, fills: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 } }] };
  assert.equal(sourceFromText('Figma export', JSON.stringify({ document: { type: 'DOCUMENT', children: [text] } })).rules[0]!.size, '32px');
  const rows = figmaRules({ document: { children: [text, { ...text, id: '1:3', characterStyleOverrides: [0, 1] }] } }, 'figma'); assert.equal(rows.length, 1); assert.equal(rows[0]!.size, '32px'); assert.equal(rows[0]!.color, '#000000');
});

test('local intake saves reviewed versions, rejects conflicts and preserves upload isolation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'auditor-intake-')); const server = intakeServer(root); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const post = async (path: string, body: unknown, origin = url) => fetch(url + path, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  try {
    assert.equal((await post('/api/import', { type: 'text', value: 'Heading 32px #333' }, 'http://elsewhere.example')).status, 403);
    const response = await post('/api/import', { type: 'file', name: '../../style.css', data: Buffer.from('h1 {font-size:32px;color:#333}').toString('base64'), mediaType: 'text/css' }); const source = await response.json(); assert.equal(response.status, 200); assert.equal(source.original, undefined);
    const body = { name: 'My system', reviewed: true, rules: source.rules };
    assert.equal((await post('/api/save', { ...body, reviewed: false })).status, 400);
    assert.equal((await post('/api/save', { ...body, rules: [...source.rules, { ...source.rules[0], size: '33px' }] })).status, 400);
    const savedResponse = await post('/api/save', body); const saved = await savedResponse.json(); assert.equal(savedResponse.status, 200);
    const onDisk = JSON.parse(await readFile(join(root, saved.savedPath), 'utf8')); assert.equal(onDisk.rules[0].size, '32px'); assert.equal(onDisk.sources[0].sha256, source.sha256);
    const second = await (await post('/api/save', body)).json(); assert.notEqual(second.id, saved.id); assert.equal((await readdir(join(root, 'reports/design-systems'))).length, 2);
    assert.equal((await post('/api/save', { ...body, rules: [{ ...source.rules[0], size: 'url(https://evil.example)', color: '' }] })).status, 400);
    await mkdir(join(root, 'other')); const alt = await mkdtemp(join(tmpdir(), 'auditor-symlink-')); await symlink(alt, join(root, 'other', 'reports'));
    const guarded = intakeServer(join(root, 'other')); await new Promise<void>(resolve => guarded.listen(0, '127.0.0.1', resolve));
    try { const guardedUrl = `http://127.0.0.1:${(guarded.address() as { port: number }).port}`; const result = await fetch(guardedUrl + '/api/save', { method: 'POST', headers: { Origin: guardedUrl, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Blocked', reviewed: true, rules: [{ name: 'Manual', size: '16px', color: '', theme: 'all', sourceId: 'manual' }] }) }); assert.equal(result.status, 400); assert.deepEqual(await readdir(alt), []); } finally { await new Promise<void>(resolve => guarded.close(() => resolve())); await rm(alt, { recursive: true, force: true }); }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('intake browser replaces the active design system and preserves it after a failed import', { timeout: 60000 }, async () => {
  const configuredFigma = process.env.FIGMA_ACCESS_TOKEN; delete process.env.FIGMA_ACCESS_TOKEN;
  const root = await mkdtemp(join(tmpdir(), 'auditor-intake-ui-')); const server = intakeServer(root); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM ?? chromium.executablePath() });
  try {
    const page = await browser.newPage({ viewport: { width: 390, height: 844 } }); const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    assert.equal(await page.locator('#rule-panel').isHidden(), true);
    await page.getByLabel('Design system link').fill('Heading: 32px #183b36');
    await page.getByRole('button', { name: 'Load design system', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('.rule').length === 1);
    await page.locator('#files').setInputFiles({ name: 'styles.css', mimeType: 'text/css', buffer: Buffer.from('.body {font-size:16px;color:#444}') });
    await page.getByText('styles.css', { exact: true }).waitFor();
    assert.equal(await page.locator('.rule').count(), 1);
    await page.getByLabel('Design system link').fill('https://www.figma.com/design/abcde/Example');
    await page.getByRole('button', { name: 'Replace design system', exact: true }).click();
    await page.getByText('This Figma link needs a connection. Upload a Figma JSON export to continue.').waitFor();
    assert.equal(await page.locator('.source').count(), 1);
    await page.getByRole('button', { name: 'Confirm and continue', exact: true }).click();
    await page.locator('#target-panel').waitFor({ state: 'visible' });
    const savedPath = await page.locator('#saved code').innerText();
    const persisted = JSON.parse(await readFile(join(root, savedPath), 'utf8'));
    assert.equal(persisted.sources.length, 1);
    assert.equal(persisted.sources[0].name, 'styles.css');
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally { if (configuredFigma !== undefined) process.env.FIGMA_ACCESS_TOKEN = configuredFigma; await browser.close(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
