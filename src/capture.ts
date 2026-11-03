import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Browser, Page } from 'playwright-core';
import { CAPTURE_SCHEMA_VERSION, EXPANDED_SCHEMA_VERSION } from './contracts.js';
import type { AuditInput, CaptureMetadata, Observation, Run, Theme } from './contracts.js';
import { applicable } from './engine.js';
import { expectationCss } from './normalize.js';
import { captureTarget, diagnosticMessage, requestAllowed } from './capture-policy.js';

const LEGACY_PROPERTIES = new Set(['background-color', 'font-size', 'column-gap', 'border-bottom-width', 'width']);
const PROPERTIES = new Set([...LEGACY_PROPERTIES, 'color', 'border-top-color', 'border-bottom-color', 'border-right-color', 'border-top-width', 'border-right-width', 'padding-top', 'padding-bottom', 'margin-top', 'font-family', 'font-weight', 'line-height', 'letter-spacing', 'text-transform', 'text-wrap', 'position', 'box-shadow', 'border-top-left-radius', 'border-top-right-radius', 'border-bottom-left-radius', 'border-bottom-right-radius']);
interface Definition { id: string; selector: string; property: string; expression: string | null }
interface Reference { id: string; expression: string; value: string | number }
export interface CaptureOptions {
  url: string;
  widths: number[];
  themes: Theme[];
  height: number;
  outputDirectory: string;
  outputPath: string;
  timeoutMs?: number;
  maxDocumentHeight?: number;
  maxPixels?: number;
  onProgress?: (run: Run) => void;
}
async function references(page: Page, definitions: Definition[]): Promise<Reference[]> {
  await page.setContent('<!doctype html><html><head><style>*{box-sizing:border-box}body{margin:0}</style></head><body></body></html>');
  return page.evaluate((definitions) => definitions.flatMap(def => {
    if (!def.expression || !CSS.supports(def.property, def.expression)) return [];
    const element = document.createElement('div');
    element.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;width:400px;height:10px;border-style:solid;';
    element.style.setProperty(def.property, def.expression);
    document.body.append(element);
    const value = def.property === 'width' ? element.getBoundingClientRect().width : getComputedStyle(element).getPropertyValue(def.property);
    element.remove();
    return [{ id: def.id, expression: def.expression, value }];
  }), definitions);
}
async function scrollWholePage(page: Page, height: number, maximumHeight: number): Promise<number> {
  let steps = 0;
  let bottomStable = 0;
  let previousHeight = -1;
  for (let y = 0; steps < 120; y += Math.max(100, Math.floor(height * 0.75))) {
    const size = await page.evaluate(() => Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0));
    if (size > maximumHeight) throw new Error(`Document height ${size}px exceeds capture cap ${maximumHeight}px.`);
    await page.evaluate(async (position) => { window.scrollTo(0, position); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); }, y);
    steps++;
    if (y + height >= size) {
      bottomStable = size === previousHeight ? bottomStable + 1 : 0;
      if (bottomStable >= 1) break;
      previousHeight = size;
    }
  }
  if (steps >= 120) throw new Error('Scroll-readiness cap reached.');
  await page.evaluate(async () => { window.scrollTo(0, 0); await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))); });
  return steps;
}
export async function captureLocal(browser: Browser, baseline: AuditInput['baseline'], options: CaptureOptions): Promise<AuditInput> {
  const expanded = baseline.rules.some(rule => rule.expectation && (!['color', 'px', 'clamp-vw', 'unsupported'].includes(rule.expectation.kind) || !LEGACY_PROPERTIES.has(rule.property ?? '')));
  const target = captureTarget(options.url);
  const timeout = options.timeoutMs ?? 12000;
  const maxHeight = options.maxDocumentHeight ?? 25000;
  const maxPixels = options.maxPixels ?? 40_000_000;
  if (!options.widths.length || !options.themes.length || new Set(options.widths).size !== options.widths.length || new Set(options.themes).size !== options.themes.length) throw new Error('Capture contexts must be nonempty and unique.');
  for (const width of options.widths) if (!Number.isSafeInteger(width) || width < 1 || width > 4096) throw new Error('Widths must be integers from 1 to 4096 CSS px.');
  if (!Number.isSafeInteger(options.height) || options.height < 200 || options.height > 2160) throw new Error('Height must be 200-2160 CSS px.');
  const runs: Run[] = [];
  for (const theme of options.themes) for (const width of options.widths) {
    const viewport = { width, height: options.height, deviceScaleFactor: 1 };
    const metadata: CaptureMetadata = {
      capturedAt: new Date().toISOString(), browser: `Chromium ${browser.version()}`, allowedOrigin: target.origin, finalUrl: '', requestedViewport: viewport,
      achievedTheme: null, fontsReady: false, document: { width: 0, height: 0 }, enumeration: [], issues: [], scrollSteps: 0, measurement: expanded ? 'browser-reference-v2' : 'browser-reference-v1',
    };
    const run: Run = { id: `${theme}-${width}`, pageUrl: target.href, viewport, theme, status: 'failed', reason: 'Capture not completed.', observations: [], capture: metadata };
    const issue = (raw: string) => { const message = diagnosticMessage(raw); if (metadata.issues.length < 100 && !metadata.issues.includes(message)) metadata.issues.push(message); };
    let criticalFailure = false;
    const context = await browser.newContext({ viewport: { width, height: options.height }, deviceScaleFactor: 1, colorScheme: theme, reducedMotion: 'reduce', serviceWorkers: 'block', acceptDownloads: false });
    context.setDefaultTimeout(timeout); context.setDefaultNavigationTimeout(timeout);
    try {
      await context.addInitScript((theme) => { try { localStorage.setItem('theme-v2', theme); } catch { /* about:blank has no local storage */ } }, theme);
      await context.route('**/*', async route => {
        const request = route.request();
        if (!requestAllowed(request.url(), request.method(), request.isNavigationRequest(), !request.isNavigationRequest() || request.frame().parentFrame() === null, target)) {
          issue(`Blocked ${request.method()} ${request.resourceType()}: ${request.url()}`);
          if (['stylesheet', 'font', 'script'].includes(request.resourceType())) criticalFailure = true;
          await route.abort('blockedbyclient');
        } else {
          // Route continuation can follow redirects without a second interception. Fetch exactly
          // one allowed hop and fulfill its response, so a 3xx never reaches the browser navigator.
          try {
            const response = await route.fetch({ maxRedirects: 0, maxRetries: 0, timeout });
            try {
              if (response.status() >= 300 && response.status() < 400) {
                issue(`Redirect blocked (${response.status()}): ${request.url()}`);
                if (request.isNavigationRequest() || ['stylesheet', 'font', 'script'].includes(request.resourceType())) criticalFailure = true;
                await route.abort('blockedbyclient');
              } else await route.fulfill({ response });
            } finally { await response.dispose(); }
          } catch (error) {
            issue(`Allowed request failed: ${request.url()} (${error instanceof Error ? error.message : 'request failure'})`);
            if (['stylesheet', 'font', 'script'].includes(request.resourceType())) criticalFailure = true;
            await route.abort('failed');
          }
        }
      });
      await context.routeWebSocket('**/*', route => { issue(`WebSocket blocked: ${route.url()}`); route.close(); });
      context.on('page', page => { page.on('dialog', dialog => { issue(`Dialog dismissed: ${dialog.type()}`); void dialog.dismiss(); }); });
      const page = await context.newPage();
      page.on('pageerror', error => { criticalFailure = true; issue(`Page script failed: ${error.message}`); });
      page.on('requestfailed', request => {
        issue(`Request failed (${request.resourceType()}): ${request.url()}`);
        if (['stylesheet', 'font', 'script'].includes(request.resourceType())) criticalFailure = true;
      });
      page.on('response', response => {
        if (response.status() >= 400) {
          issue(`HTTP ${response.status()} (${response.request().resourceType()}): ${response.url()}`);
          if (['stylesheet', 'font', 'script'].includes(response.request().resourceType())) criticalFailure = true;
        }
      });
      const response = await page.goto(target.href, { waitUntil: 'load' });
      if (!response || response.status() >= 400 || page.url() !== target.href) throw new Error('Target navigation did not reach the selected page successfully.');
      metadata.finalUrl = page.url();
      metadata.document = await page.evaluate(() => ({ width: Math.max(document.documentElement.scrollWidth, innerWidth), height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) }));
      metadata.scrollSteps = await scrollWholePage(page, options.height, maxHeight);
      await page.waitForFunction(() => document.fonts.status === 'loaded');
      await page.evaluate(async () => { await document.fonts.ready; });
      const state = await page.evaluate(() => ({
        width: innerWidth, height: innerHeight, dpr: devicePixelRatio, theme: document.documentElement.dataset.theme ?? null,
        document: { width: Math.max(document.documentElement.scrollWidth, innerWidth), height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) },
        fontError: [...document.fonts].some(font => font.status === 'error'),
        frames: document.querySelectorAll('iframe,frame').length,
        shadows: [...document.querySelectorAll('*')].filter(element => element.shadowRoot).length,
        imagesPending: [...document.images].filter(image => !image.complete || image.naturalWidth === 0).length,
      }));
      metadata.document = state.document;
      metadata.achievedTheme = state.theme === 'dark' || state.theme === 'light' ? state.theme : null;
      metadata.fontsReady = !state.fontError;
      if (criticalFailure || !metadata.fontsReady) throw new Error('Critical stylesheet/script/font or font-readiness failure; observations are unchecked.');
      if (state.width !== width || state.height !== options.height || state.dpr !== 1 || metadata.achievedTheme !== theme) throw new Error('Achieved viewport/theme differs from the requested context.');
      if (state.document.height > maxHeight || width * state.document.height > maxPixels) throw new Error('Full-page dimensions exceed capture caps.');
      if (state.frames) issue(`${state.frames} frame(s) excluded from main-document checks.`);
      if (state.shadows) issue(`${state.shadows} open shadow root(s) excluded from selector enumeration.`);
      if (state.imagesPending) issue(`${state.imagesPending} image(s) not ready or failed; image coverage is incomplete.`);
      const definitions: Definition[] = baseline.rules.filter(rule => rule.status === 'established' && applicable(rule, run)).map(rule => ({ id: rule.id, selector: rule.selector!, property: rule.property!, expression: PROPERTIES.has(rule.property!) ? expectationCss(rule.expectation!, theme) : null }));
      const referencePage = await context.newPage();
      const referenceValues = await references(referencePage, definitions);
      await referencePage.close();
      const measured = await page.evaluate(({ definitions, references }) => {
        const observations: Observation[] = [];
        const enumeration: CaptureMetadata['enumeration'] = [];
        for (const definition of definitions) {
          let elements: Element[];
          try { elements = [...document.querySelectorAll(definition.selector)]; } catch { throw new Error(`Invalid selector for ${definition.id}`); }
          if (elements.length > 2000) throw new Error(`Element count cap for ${definition.id}`);
          let hidden = 0;
          const reference = references.find(reference => reference.id === definition.id);
          for (const [index, element] of elements.entries()) {
            const style = getComputedStyle(element); const rect = element.getBoundingClientRect();
            const obs: Observation = { ruleId: definition.id, element: `${definition.selector}[match=${index + 1}]`, state: 'unsupported', reason: 'Unsupported property or reference expression.', position: { x: rect.x + scrollX, y: rect.y + scrollY }, bounds: { width: rect.width, height: rect.height } };
            if (!rect.width || !rect.height || style.visibility === 'hidden' || style.display === 'none') { hidden++; obs.reason = 'Element is not rendered in the selected static state.'; }
            else if (definition.property === 'column-gap' && !['grid', 'inline-grid', 'flex', 'inline-flex'].includes(style.display)) obs.reason = 'Gap has no supported active grid/flex layout context.';
            else if (reference) {
              obs.state = 'measured'; delete obs.reason;
              obs.value = definition.property === 'width' ? rect.width : style.getPropertyValue(definition.property);
              obs.reference = { expression: reference.expression, value: reference.value };
            }
            observations.push(obs);
          }
          enumeration.push({ ruleId: definition.id, matched: elements.length, hidden });
        }
        return { observations, enumeration };
      }, { definitions, references: referenceValues });
      metadata.enumeration = measured.enumeration;
      run.observations = measured.observations;
      await page.mouse.move(width - 1, 0);
      const image = await page.screenshot({ fullPage: true, animations: 'disabled', caret: 'hide', scale: 'css', timeout });
      const after = await page.evaluate(() => ({ width: innerWidth, height: Math.max(document.documentElement.scrollHeight, document.body?.scrollHeight ?? 0) }));
      if (after.width !== width || after.height !== state.document.height || image.readUInt32BE(16) !== width || image.readUInt32BE(20) !== state.document.height) throw new Error('Screenshot dimensions or document layout changed during capture.');
      if (criticalFailure) throw new Error('Critical asset or script failed during capture.');
      const check = await page.evaluate((definitions) => definitions.map(def => ({ id: def.id, elements: [...document.querySelectorAll(def.selector)].map((element, index) => {
        const rect = element.getBoundingClientRect();
        return { element: `${def.selector}[match=${index + 1}]`, value: def.property === 'width' ? rect.width : getComputedStyle(element).getPropertyValue(def.property), position: { x: rect.x + scrollX, y: rect.y + scrollY }, bounds: { width: rect.width, height: rect.height } };
      }) })), definitions);
      for (const entry of check) {
        const counted = metadata.enumeration.find(item => item.ruleId === entry.id)!;
        if (entry.elements.length !== counted.matched) throw new Error('Selector matches changed during screenshot capture.');
        for (const observation of run.observations.filter(obs => obs.ruleId === entry.id && obs.state === 'measured')) {
          const element = entry.elements.find(element => element.element === observation.element);
          if (!element || element.value !== observation.value || JSON.stringify(element.position) !== JSON.stringify(observation.position) || JSON.stringify(element.bounds) !== JSON.stringify(observation.bounds)) throw new Error('Observed styles or geometry changed during screenshot capture.');
        }
      }
      const filename = `${run.id}.png`;
      await writeFile(join(options.outputDirectory, filename), image, { flag: 'wx' });
      metadata.screenshot = { path: `${options.outputPath}/${filename}`, sha256: createHash('sha256').update(image).digest('hex'), width: image.readUInt32BE(16), height: image.readUInt32BE(20), kind: 'full-page' };
      for (const observation of run.observations) observation.evidence = metadata.screenshot.path;
      run.status = 'captured'; delete run.reason;
    } catch (error) {
      run.reason = diagnosticMessage(error instanceof Error ? error.message : 'Capture failed.');
      issue(run.reason); run.observations = []; metadata.enumeration = [];
    } finally { await context.close(); }
    runs.push(run); options.onProgress?.(run);
  }
  return { schemaVersion: expanded ? EXPANDED_SCHEMA_VERSION : CAPTURE_SCHEMA_VERSION, evidenceKind: 'local-capture', baseline, runs };
}
