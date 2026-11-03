import { isIP } from 'node:net';
import { CAPTURE_SCHEMA_VERSION, CATEGORIES, EXPANDED_SCHEMA_VERSION, SCHEMA_VERSION } from './contracts.js';
import { expectationCss, normalizeObserved, resolveExpected, sameValue } from './normalize.js';
import type { AuditInput, Rule } from './contracts.js';

type RecordValue = Record<string, unknown>;
function fail(path: string, message: string): never { throw new Error(`${path}: ${message}`); }
function record(value: unknown, path: string): RecordValue {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(path, 'expected an object');
  return value as RecordValue;
}
function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || !value.trim()) fail(path, 'expected a nonempty string');
  return value;
}
function number(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < minimum) fail(path, `expected a finite number >= ${minimum}`);
  return value;
}
function array(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) fail(path, 'expected an array');
  return value;
}
function oneOf(value: unknown, options: readonly string[], path: string): void {
  if (typeof value !== 'string' || !options.includes(value)) fail(path, `expected ${options.join(' | ')}`);
}
function unique(values: string[], path: string): void {
  if (new Set(values).size !== values.length) fail(path, 'duplicate identifiers');
}
function optionalText(obj: RecordValue, key: string, path: string): void {
  if (obj[key] !== undefined) text(obj[key], `${path}.${key}`);
}
function keys(obj: RecordValue, allowed: string[], path: string): void {
  for (const key of Object.keys(obj)) if (!allowed.includes(key)) fail(path, `unknown field ${key}`);
}
export function isLoopbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const host = url.hostname.replace(/^\[|\]$/g, '');
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && (host === 'localhost' || host === '::1' || (isIP(host) === 4 && host.startsWith('127.')));
  } catch { return false; }
}
function expectation(value: unknown, path: string): void {
  const exp = record(value, path);
  switch (exp.kind) {
    case 'color': {
      keys(exp, ['kind', 'value'], path);
      if (typeof exp.value === 'string') text(exp.value, `${path}.value`);
      else {
        const modes = record(exp.value, `${path}.value`);
        keys(modes, ['dark', 'light'], `${path}.value`);
        text(modes.dark, `${path}.value.dark`); text(modes.light, `${path}.value.light`);
      }
      break;
    }
    case 'max-px': case 'number':
      keys(exp, ['kind', 'value'], path); number(exp.value, `${path}.value`); break;
    case 'keyword':
      keys(exp, ['kind', 'value'], path);
      if (!/^[a-z-]+$/.test(text(exp.value, `${path}.value`))) fail(path, 'expected a single CSS keyword');
      break;
    case 'font-family': {
      keys(exp, ['kind', 'value', 'aliases'], path);
      const families = [text(exp.value, `${path}.value`), ...(exp.aliases === undefined ? [] : array(exp.aliases, `${path}.aliases`).map(value => text(value, path)))];
      if (families.some(value => !/^[a-zA-Z][a-zA-Z0-9 -]*$/.test(value))) fail(path, 'unsupported font family name');
      break;
    }
    case 'font-relative': {
      keys(exp, ['kind', 'factor', 'fontSize'], path); number(exp.factor, `${path}.factor`, -100);
      const size = record(exp.fontSize, `${path}.fontSize`);
      if (!['px', 'clamp-vw'].includes(String(size.kind))) fail(path, 'font-relative needs an independent source px/clamp font size');
      expectation(size, `${path}.fontSize`); break;
    }
    case 'px':
      keys(exp, ['kind', 'value'], path); number(exp.value, `${path}.value`); break;
    case 'clamp-vw':
      keys(exp, ['kind', 'min', 'vw', 'max'], path);
      number(exp.min, `${path}.min`); number(exp.vw, `${path}.vw`);
      number(exp.max, `${path}.max`, exp.min as number); break;
    case 'unsupported':
      keys(exp, ['kind', 'expression'], path); text(exp.expression, `${path}.expression`); break;
    default: fail(path, 'unsupported contract kind; use kind=unsupported to record an unchecked expression');
  }
}
export function validateInput(value: unknown): AuditInput {
  const input = record(value, 'input');
  keys(input, ['schemaVersion', 'evidenceKind', 'baseline', 'runs'], 'input');
  if (input.schemaVersion !== SCHEMA_VERSION && input.schemaVersion !== CAPTURE_SCHEMA_VERSION && input.schemaVersion !== EXPANDED_SCHEMA_VERSION) fail('schemaVersion', 'unsupported version');
  oneOf(input.evidenceKind, ['synthetic', 'local-capture'], 'evidenceKind');
  if (input.evidenceKind === 'local-capture' && ![CAPTURE_SCHEMA_VERSION, EXPANDED_SCHEMA_VERSION].includes(input.schemaVersion as '1.1' | '1.2')) fail('schemaVersion', 'local captures require version 1.1 or 1.2');
  const baseline = record(input.baseline, 'baseline');
  keys(baseline, ['id', 'version', 'coverage', 'scope', 'sources', 'rules'], 'baseline');
  text(baseline.id, 'baseline.id'); text(baseline.version, 'baseline.version');
  oneOf(baseline.coverage, ['partial', 'declared-rules'], 'baseline.coverage');
  if (baseline.scope !== undefined) {
    oneOf(baseline.scope, ['documented-visual'], 'baseline.scope');
    if (input.schemaVersion !== EXPANDED_SCHEMA_VERSION) fail('baseline.scope', 'documented visual scope requires schema 1.2');
  }
  const sourceIds: string[] = [];
  for (const [i, item] of array(baseline.sources, 'baseline.sources').entries()) {
    const path = `sources[${i}]`; const source = record(item, path);
    keys(source, ['id', 'url', 'snapshot', 'sha256'], path);
    sourceIds.push(text(source.id, `${path}.id`));
    const url = new URL(text(source.url, `${path}.url`));
    if (url.protocol !== 'https:' || url.username || url.password) fail(path, 'source must be an HTTPS URL without credentials');
    text(source.snapshot, `${path}.snapshot`);
    if (!/^[a-f0-9]{64}$/.test(text(source.sha256, `${path}.sha256`))) fail(path, 'invalid SHA256');
  }
  unique(sourceIds, 'sources');
  const ruleIds: string[] = [];
  for (const [i, item] of array(baseline.rules, 'baseline.rules').entries()) {
    const path = `rules[${i}]`; const rule = record(item, path);
    keys(rule, ['id', 'category', 'status', 'selector', 'property', 'source', 'condition', 'expectation', 'reason', 'recommendation'], path);
    ruleIds.push(text(rule.id, `${path}.id`));
    oneOf(rule.category, CATEGORIES, `${path}.category`);
    oneOf(rule.status, ['established', 'proposed', 'missing-guidance', 'ambiguous', 'deferred'], `${path}.status`);
    for (const key of ['selector', 'property', 'reason', 'recommendation']) optionalText(rule, key, path);
    if (rule.source !== undefined) {
      const source = record(rule.source, `${path}.source`); keys(source, ['id', 'anchor'], `${path}.source`);
      if (!sourceIds.includes(text(source.id, `${path}.source.id`))) fail(path, 'unknown source id');
      if (!/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(text(source.anchor, `${path}.source.anchor`))) fail(path, 'invalid source section anchor');
    }
    if (rule.condition !== undefined) {
      const condition = record(rule.condition, `${path}.condition`);
      keys(condition, ['minWidthExclusive', 'maxWidth', 'themes'], `${path}.condition`);
      if (condition.minWidthExclusive !== undefined) number(condition.minWidthExclusive, `${path}.minWidthExclusive`);
      if (condition.maxWidth !== undefined) number(condition.maxWidth, `${path}.maxWidth`, 1);
      if (condition.minWidthExclusive !== undefined && condition.maxWidth !== undefined && Number(condition.minWidthExclusive) >= Number(condition.maxWidth)) fail(path, 'empty width condition');
      if (condition.themes !== undefined) {
        const themes = array(condition.themes, `${path}.themes`);
        if (!themes.length) fail(path, 'empty theme condition');
        themes.forEach(theme => oneOf(theme, ['dark', 'light'], `${path}.themes`));
        unique(themes as string[], `${path}.themes`);
      }
    }
    if (rule.expectation !== undefined) {
      expectation(rule.expectation, `${path}.expectation`);
      if (!['color', 'px', 'clamp-vw', 'unsupported'].includes(String((rule.expectation as RecordValue).kind)) && input.schemaVersion !== EXPANDED_SCHEMA_VERSION) fail(path, 'expanded expectations require schema 1.2');
    }
    if (rule.status === 'established') {
      for (const key of ['selector', 'property']) text(rule[key], `${path}.${key}`);
      if (rule.source === undefined || rule.expectation === undefined) fail(path, 'established rule requires source and expectation');
    } else text(rule.reason, `${path}.reason`);
    if (baseline.scope === 'documented-visual') {
      const property = String(rule.property);
      const visualProperty = /^(?:color|background-color|font-(?:family|size|weight)|line-height|letter-spacing|text-(?:wrap|transform)|(?:padding|margin)-(?:top|right|bottom|left)|(?:row|column)-gap|(?:min-|max-)?(?:width|height)|position|box-shadow|border-(?:(?:top|right|bottom|left)-(?:color|width|style)|(?:top|bottom)-(?:left|right)-radius))$/.test(property);
      if (rule.status !== 'established' || (rule.expectation as RecordValue | undefined)?.kind === 'unsupported' || !visualProperty) fail(path, 'documented visual scope accepts only established, supported visual rules');
    }
  }
  if (!ruleIds.length) fail('rules', 'at least one rule is required');
  unique(ruleIds, 'rules');
  const runIds: string[] = [];
  for (const [i, item] of array(input.runs, 'runs').entries()) {
    const path = `runs[${i}]`; const run = record(item, path);
    keys(run, ['id', 'pageUrl', 'viewport', 'theme', 'status', 'reason', 'observations', 'capture'], path);
    runIds.push(text(run.id, `${path}.id`));
    if (!isLoopbackUrl(text(run.pageUrl, `${path}.pageUrl`))) fail(path, 'target must be a loopback HTTP(S) URL without credentials');
    oneOf(run.theme, ['dark', 'light'], `${path}.theme`);
    oneOf(run.status, ['captured', 'failed'], `${path}.status`);
    optionalText(run, 'reason', path);
    if (run.status === 'failed') text(run.reason, `${path}.reason`);
    const viewport = record(run.viewport, `${path}.viewport`);
    keys(viewport, ['width', 'height', 'deviceScaleFactor'], `${path}.viewport`);
    for (const key of ['width', 'height']) {
      if (!Number.isSafeInteger(number(viewport[key], `${path}.${key}`, 1))) fail(path, 'viewport dimensions must be safe positive integers');
    }
    if (number(viewport.deviceScaleFactor, `${path}.deviceScaleFactor`) === 0) fail(path, 'pixel ratio must be positive');
    const observationIds: string[] = [];
    for (const [j, item] of array(run.observations, `${path}.observations`).entries()) {
      const at = `${path}.observations[${j}]`; const obs = record(item, at);
      keys(obs, ['ruleId', 'element', 'state', 'value', 'reason', 'evidence', 'position', 'reference', 'bounds'], at);
      if (!ruleIds.includes(text(obs.ruleId, `${at}.ruleId`))) fail(at, 'unknown rule id');
      text(obs.element, `${at}.element`);
      observationIds.push(JSON.stringify([obs.ruleId, obs.element]));
      oneOf(obs.state, ['measured', 'unsupported', 'failed'], `${at}.state`);
      for (const key of ['reason', 'evidence']) optionalText(obs, key, at);
      if (obs.value !== undefined) {
        if (typeof obs.value === 'number') number(obs.value, `${at}.value`);
        else text(obs.value, `${at}.value`);
      }
      if (obs.state === 'measured' && obs.value === undefined) fail(at, 'measured observation requires value');
      if (obs.state !== 'measured') text(obs.reason, `${at}.reason`);
      if (obs.position !== undefined) {
        const position = record(obs.position, `${at}.position`); keys(position, ['x', 'y'], `${at}.position`);
        for (const key of ['x', 'y']) number(position[key], `${at}.position.${key}`, -Number.MAX_VALUE);
      }
    }
      // Additional browser-reference fields are validated below as one versioned capture contract.
    unique(observationIds, `${path}.observations`);
    if (input.evidenceKind === 'local-capture') {
      validateCapture(run, baseline.rules as unknown[], path);
      const measurement = (run.capture as RecordValue).measurement;
      if ((input.schemaVersion === CAPTURE_SCHEMA_VERSION && measurement !== 'browser-reference-v1') || (input.schemaVersion === EXPANDED_SCHEMA_VERSION && measurement !== 'browser-reference-v2')) fail(path, 'measurement policy must match capture schema');
    }
    else if (run.capture !== undefined || (run.observations as RecordValue[]).some(obs => obs.reference !== undefined || obs.bounds !== undefined)) fail(path, 'browser metadata is only valid for local captures');
  }
  if (!runIds.length) fail('runs', 'at least one run is required');
  unique(runIds, 'runs');
  return structuredClone(value) as AuditInput;
}

function validateCapture(run: RecordValue, rules: unknown[], path: string): void {
  const capture = record(run.capture, `${path}.capture`);
  keys(capture, ['capturedAt', 'browser', 'allowedOrigin', 'finalUrl', 'requestedViewport', 'achievedTheme', 'fontsReady', 'document', 'screenshot', 'enumeration', 'issues', 'scrollSteps', 'measurement'], `${path}.capture`);
  if (!Number.isFinite(Date.parse(text(capture.capturedAt, 'capture.capturedAt')))) fail(path, 'invalid capture timestamp');
  text(capture.browser, 'capture.browser');
  const origin = new URL(run.pageUrl as string).origin;
  if (capture.allowedOrigin !== origin) fail(path, 'capture origin differs from target');
  if (capture.finalUrl !== '') {
    const final = new URL(text(capture.finalUrl, 'capture.finalUrl'));
    if (final.origin !== origin || final.href !== new URL(run.pageUrl as string).href) fail(path, 'unexpected final navigation');
  }
  if (capture.achievedTheme !== null) oneOf(capture.achievedTheme, ['light', 'dark'], 'capture.achievedTheme');
  if (typeof capture.fontsReady !== 'boolean') fail(path, 'fontsReady must be boolean');
  if (capture.measurement !== 'browser-reference-v1' && capture.measurement !== 'browser-reference-v2') fail(path, 'unknown browser measurement policy');
  if (!Number.isSafeInteger(number(capture.scrollSteps, 'capture.scrollSteps'))) fail(path, 'invalid scroll step count');
  const requested = record(capture.requestedViewport, 'capture.requestedViewport');
  keys(requested, ['width', 'height', 'deviceScaleFactor'], 'capture.requestedViewport');
  for (const key of ['width', 'height', 'deviceScaleFactor']) number(requested[key], `requestedViewport.${key}`, Number.MIN_VALUE);
  const dimensions = record(capture.document, 'capture.document');
  keys(dimensions, ['width', 'height'], 'capture.document');
  number(dimensions.width, 'capture.document.width'); number(dimensions.height, 'capture.document.height');
  array(capture.issues, 'capture.issues').forEach(issue => text(issue, 'capture.issue'));
  const ids: string[] = [];
  for (const item of array(capture.enumeration, 'capture.enumeration')) {
    const entry = record(item, 'capture.enumeration.entry');
    keys(entry, ['ruleId', 'matched', 'hidden'], 'capture.enumeration.entry');
    const id = text(entry.ruleId, 'enumeration.ruleId'); ids.push(id);
    if (!rules.some(rule => (rule as Rule).id === id)) fail(path, 'unknown enumerated rule');
    for (const key of ['matched', 'hidden']) if (!Number.isSafeInteger(number(entry[key], `enumeration.${key}`))) fail(path, 'enumeration counts must be integers');
    if (Number(entry.hidden) > Number(entry.matched)) fail(path, 'hidden count exceeds matches');
    if ((run.observations as RecordValue[]).filter(obs => obs.ruleId === id).length !== entry.matched) fail(path, 'enumeration and observation counts differ');
  }
  unique(ids, 'capture.enumeration');
  if (capture.screenshot !== undefined) {
    const image = record(capture.screenshot, 'capture.screenshot');
    keys(image, ['path', 'sha256', 'width', 'height', 'kind'], 'capture.screenshot');
    text(image.path, 'screenshot.path');
    if (!/^[a-f0-9]{64}$/.test(text(image.sha256, 'screenshot.sha256'))) fail(path, 'invalid screenshot digest');
    for (const key of ['width', 'height']) if (!Number.isSafeInteger(number(image[key], `screenshot.${key}`, 1))) fail(path, 'invalid screenshot dimensions');
    if (image.kind !== 'full-page') fail(path, 'unknown screenshot kind');
  }
  if (run.status === 'captured') {
    if (capture.finalUrl === '' || capture.achievedTheme !== run.theme || !capture.fontsReady || !capture.screenshot) fail(path, 'successful capture needs achieved theme, fonts and screenshot');
    const actual = run.viewport as RecordValue;
    for (const key of ['width', 'height', 'deviceScaleFactor']) if (requested[key] !== actual[key]) fail(path, 'achieved viewport differs from requested viewport');
    const image = capture.screenshot as RecordValue;
    if (image.width !== actual.width || image.height !== dimensions.height) fail(path, 'screenshot is not aligned with the captured CSS document');
    for (const rule of rules as Rule[]) {
      const condition = rule.condition;
      const applies = (!condition?.themes || condition.themes.includes(run.theme as 'dark' | 'light')) && (condition?.maxWidth === undefined || Number(actual.width) <= condition.maxWidth) && (condition?.minWidthExclusive === undefined || Number(actual.width) > condition.minWidthExclusive);
      if (rule.status === 'established' && applies && !ids.includes(rule.id)) fail(path, 'missing applicable selector enumeration');
    }
  }
  for (const obs of run.observations as RecordValue[]) {
    if (obs.bounds !== undefined) {
      const bounds = record(obs.bounds, 'observation.bounds'); keys(bounds, ['width', 'height'], 'bounds');
      number(bounds.width, 'bounds.width'); number(bounds.height, 'bounds.height');
    }
    if (obs.reference !== undefined) {
      const reference = record(obs.reference, 'observation.reference'); keys(reference, ['expression', 'value'], 'reference');
      const rule = (rules as Rule[]).find(rule => rule.id === obs.ruleId)!;
      if (!rule.expectation || reference.expression !== expectationCss(rule.expectation, run.theme as 'dark' | 'light')) fail(path, 'reference expression is not the source-backed expectation');
      if (typeof reference.value === 'number') number(reference.value, 'reference.value'); else text(reference.value, 'reference.value');
      if (capture.measurement === 'browser-reference-v2') {
        const exp = rule.expectation;
        const integer = ['px', 'max-px', 'number'].includes(exp.kind) && 'value' in exp && Number.isInteger(exp.value);
        if (integer || exp.kind === 'keyword' || exp.kind === 'font-family') {
          const expected = resolveExpected(exp, run.theme as 'dark' | 'light', Number((run.viewport as RecordValue).width));
          const actual = normalizeObserved(reference.value as string | number, exp);
          if (!expected || !actual || !sameValue(expected, actual)) fail(path, 'independent reference contradicts literal source expectation');
        }
      }
    }
    if (obs.state === 'measured' && (obs.reference === undefined || obs.bounds === undefined || obs.position === undefined)) fail(path, 'measured local observation needs independent reference and document bounds');
  }
}
