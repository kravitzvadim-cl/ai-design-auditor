import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { audit } from '../src/engine.js';
import type { AuditInput, Rule } from '../src/contracts.js';
import { normalizeColor, sameValue } from '../src/normalize.js';
import { validateInput } from '../src/validation.js';

const fixture = (name = 'correct'): AuditInput => validateInput(JSON.parse(readFileSync(new URL(`../../fixtures/${name}.json`, import.meta.url), 'utf8')) as unknown);
const observation = (input: AuditInput, id: string) => input.runs[0]!.observations.find(obs => obs.ruleId === id)!;

test('clean fixtures check all five categories in both themes but remain a partial synthetic result', () => {
  const report = audit(fixture());
  assert.equal(report.evidenceKind, 'synthetic'); assert.equal(report.outcome, 'incomplete');
  assert.equal(report.summary.checked, 10); assert.equal(report.summary.counts.pass, 10);
  assert.equal(report.summary.counts.mismatch, 0);
  assert.equal(new Set(report.findings.map(finding => finding.category)).size, 5);
  assert.match(report.limitations.join(' '), /not a portfolio audit/);
});

for (const [id, bad] of [['COLOR-BG', '#ff0000'], ['TYPE-DISPLAY', '105px'], ['SPACE-GRID', '25px'], ['BORDER-SECTION', '2px'], ['LAYOUT-RAIL', '301px']] as const) {
  test(`${id}: an isolated mismatch is found, source-backed, then removed on restoration`, () => {
    const input = fixture(); const obs = observation(input, id); const original = obs.value;
    obs.value = bad;
    const report = audit(input);
    assert.equal(report.outcome, 'mismatches'); assert.equal(report.summary.counts.mismatch, 1);
    const finding = report.findings.find(item => item.status === 'mismatch')!;
    assert.equal(finding.ruleId, id); assert.equal(finding.observedValue, bad);
    assert.ok(finding.expected); assert.ok(finding.actual);
    assert.match(finding.source!.url, /\/design-system\/$/);
    assert.equal(finding.theme, 'dark'); assert.equal(finding.viewport.width, 1440);
    assert.equal(finding.property, input.baseline.rules.find(rule => rule.id === id)!.property);
    obs.value = original!;
    assert.deepEqual(audit(input), audit(fixture()));
  });
}

test('persisted seeded and restored fixture files produce the expected semantic results', () => {
  assert.equal(audit(fixture('seeded')).summary.counts.mismatch, 1);
  assert.deepEqual(audit(fixture('correct')), audit(fixture('restored')));
});

test('theme-specific color expectations cannot be substituted for the other theme', () => {
  const input = fixture(); input.runs[1]!.observations[0]!.value = '#0b0c0d';
  const bad = audit(input).findings.filter(item => item.status === 'mismatch');
  assert.equal(bad.length, 1); assert.equal(bad[0]!.theme, 'light');
});

test('fluid min/intermediate/max values and inclusive breakpoint boundaries work across 18 contexts', () => {
  const input = fixture(); const originals = input.runs;
  const expected = [[390, 44], [819, 60.606], [820, 60.68], [821, 60.754], [1079, 79.846], [1080, 79.92], [1081, 79.994], [1440, 106.56], [1920, 108]] as const;
  input.runs = originals.flatMap(run => expected.map(([width, fontSize]) => ({
    ...structuredClone(run), id: `${run.theme}-${width}`, viewport: { ...run.viewport, width },
    observations: run.observations.map(obs => ({ ...obs, value: obs.ruleId === 'TYPE-DISPLAY' ? `${fontSize}px` : obs.value! })),
  })));
  const report = audit(input);
  assert.equal(report.summary.counts.pass, 78);
  assert.equal(report.summary.counts['not-applicable'], 12);
  assert.equal(report.summary.counts.mismatch, 0);
  const phone = report.findings.filter(item => item.ruleId === 'LAYOUT-RAIL');
  assert.ok(phone.filter(item => item.viewport.width <= 820).every(item => item.status === 'not-applicable'));
  assert.ok(phone.filter(item => item.viewport.width > 820).every(item => item.status === 'pass'));
});

test('maxWidth is inclusive and minWidthExclusive excludes exactly the boundary', () => {
  const input = fixture(); const rule = input.baseline.rules[0]!;
  rule.condition = { minWidthExclusive: 1080, maxWidth: 1440, themes: ['dark'] };
  let report = audit(input);
  assert.equal(report.findings.find(item => item.ruleId === rule.id && item.theme === 'dark')!.status, 'pass');
  assert.equal(report.findings.find(item => item.ruleId === rule.id && item.theme === 'light')!.status, 'not-applicable');
  input.runs[0]!.viewport.width = 1080;
  report = audit(input);
  assert.equal(report.findings.find(item => item.ruleId === rule.id && item.theme === 'dark')!.status, 'not-applicable');
});

test('every supplied target instance is checked rather than the first match only', () => {
  const input = fixture(); const first = observation(input, 'BORDER-SECTION');
  input.runs[0]!.observations.push({ ...first, element: '.sec[fixture=2]', value: '2px' });
  const report = audit(input);
  assert.equal(report.summary.counts.pass, 10); assert.equal(report.summary.counts.mismatch, 1);
  assert.equal(report.findings.find(item => item.status === 'mismatch')!.element, '.sec[fixture=2]');
});

test('a missing observation is unchecked, never a pass or mismatch', () => {
  const input = fixture(); input.runs[0]!.observations = input.runs[0]!.observations.filter(obs => obs.ruleId !== 'SPACE-GRID');
  const report = audit(input);
  assert.equal(report.summary.counts.unchecked, 1); assert.equal(report.summary.counts.pass, 9);
  assert.equal(report.summary.counts.mismatch, 0);
});

test('unsupported observed units and explicit unsupported expectations remain unchecked', () => {
  const input = fixture(); observation(input, 'SPACE-GRID').value = '1.5rem';
  const rule = input.baseline.rules.find(rule => rule.id === 'TYPE-DISPLAY')!;
  rule.expectation = { kind: 'unsupported', expression: 'container-dependent expression not implemented' };
  const report = audit(input);
  assert.equal(report.summary.counts.unchecked, 3); assert.equal(report.summary.counts.mismatch, 0);
});

test('failed observations retain the cause and do not compare their stale values', () => {
  const input = fixture(); const obs = observation(input, 'TYPE-DISPLAY');
  obs.state = 'failed'; obs.reason = 'Synthetic font-readiness failure.'; obs.value = '999px';
  const found = audit(input).findings.find(item => item.ruleId === obs.ruleId && item.theme === 'dark')!;
  assert.equal(found.status, 'unchecked'); assert.match(found.reason, /font-readiness/);
});

test('a failed capture invalidates every applicable established check even if observations look correct', () => {
  const input = fixture(); input.runs[0]!.status = 'failed'; input.runs[0]!.reason = 'Synthetic navigation failure.';
  const report = audit(input);
  assert.equal(report.summary.counts.unchecked, 5); assert.equal(report.summary.counts.pass, 5);
  assert.ok(report.findings.filter(item => item.theme === 'dark').every(item => item.reason.includes('navigation failure')));
});

test('proposed/missing/ambiguous/deferred rules remain distinct and never enforce their expectations', () => {
  const input = fixture('coverage-gaps');
  const proposed = input.baseline.rules.find(rule => rule.status === 'proposed')!;
  proposed.expectation = { kind: 'px', value: 999 };
  input.runs[0]!.observations.push({ ruleId: proposed.id, element: '.proposal', state: 'measured', value: '0px' });
  const report = audit(input);
  for (const status of ['proposed', 'missing-guidance', 'ambiguous', 'deferred'] as const) assert.equal(report.summary.counts[status], 2);
  assert.equal(report.summary.counts.mismatch, 0);
  assert.equal(report.outcome, 'incomplete');
});

test('arbitrarily small fixture drift is not hidden by an unapproved tolerance', () => {
  const input = fixture(); observation(input, 'SPACE-GRID').value = '24.00001px';
  assert.equal(audit(input).summary.counts.mismatch, 1);
});

test('permuting run, rule and observation arrays preserves report identity and does not mutate input', () => {
  const input = fixture(); const original = JSON.stringify(input); const expected = audit(input);
  assert.equal(JSON.stringify(input), original);
  input.runs.reverse(); input.baseline.rules.reverse(); input.runs.forEach(run => run.observations.reverse());
  assert.deepEqual(audit(input), expected);
});

test('complete declared checks may pass, but unchecked or inapplicable-only input cannot', () => {
  const input = fixture(); input.baseline.coverage = 'declared-rules';
  assert.equal(audit(input).outcome, 'checked-scope-pass');
  input.baseline.rules.forEach(rule => { rule.condition = { minWidthExclusive: 2000 }; });
  assert.equal(audit(input).outcome, 'incomplete');
});

for (const [name, change] of [
  ['unknown schema version', (input: AuditInput) => { (input as unknown as { schemaVersion: string }).schemaVersion = '2.0'; }],
  ['missing established rule source', (input: AuditInput) => { delete input.baseline.rules[0]!.source; }],
  ['missing established expectation', (input: AuditInput) => { delete input.baseline.rules[0]!.expectation; }],
  ['duplicate rule ids', (input: AuditInput) => { input.baseline.rules.push(structuredClone(input.baseline.rules[0]!)); }],
  ['duplicate context ids', (input: AuditInput) => { input.runs.push(structuredClone(input.runs[0]!)); }],
  ['duplicate element observations', (input: AuditInput) => { input.runs[0]!.observations.push(structuredClone(input.runs[0]!.observations[0]!)); }],
  ['unknown observation rule', (input: AuditInput) => { input.runs[0]!.observations[0]!.ruleId = 'UNKNOWN'; }],
  ['unknown rule status', (input: AuditInput) => { (input.baseline.rules[0] as unknown as { status: string }).status = 'approved-ish'; }],
  ['NaN observation', (input: AuditInput) => { input.runs[0]!.observations[0]!.value = NaN; }],
  ['empty run list', (input: AuditInput) => { input.runs = []; }],
  ['unknown input fields', (input: AuditInput) => { Object.assign(input, { typo: true }); }],
  ['empty condition range', (input: AuditInput) => { input.baseline.rules[0]!.condition = { minWidthExclusive: 820, maxWidth: 820 }; }],
] as const) {
  test(`invalid contract: ${name} fails closed`, () => { const input = fixture(); change(input); assert.throws(() => audit(input)); });
}

for (const url of ['https://example.com/', 'http://192.168.1.1/', 'file:///tmp/page.html', 'http://user:password@localhost/', 'http://localhost.example.com/']) {
  test(`reject non-loopback or credential-bearing target ${url}`, () => {
    const input = fixture(); input.runs[0]!.pageUrl = url; assert.throws(() => audit(input), /loopback/);
  });
}

test('source and diagnostic detail survives unchecked coverage', () => {
  const input = fixture(); const obs = observation(input, 'TYPE-DISPLAY');
  obs.state = 'unsupported'; obs.reason = 'Synthetic unsupported font metric.';
  obs.evidence = 'fixtures/no-real-screenshot.png'; obs.position = { x: 400, y: 2000 };
  const report = audit(input); const found = report.findings.find(item => item.theme === 'dark' && item.ruleId === obs.ruleId)!;
  assert.equal(found.status, 'unchecked'); assert.equal(found.position!.y, 2000);
  assert.equal(found.evidence, obs.evidence); assert.ok(found.source!.sha256); assert.ok(found.expected);
});

test('supported RGB/hex forms normalize exactly; unsupported or invalid colors do not guess', () => {
  for (const [first, second] of [['#abc', 'rgb(170,187,204)'], ['#0000', 'transparent'], ['#ff0000', 'rgb(100% 0% 0% / 100%)'], ['#123456ff', 'rgba(18, 52, 86, 1)']]) {
    assert.ok(sameValue(normalizeColor(first!)!, normalizeColor(second!)!));
  }
  for (const raw of ['hsl(0 0% 0%)', 'color(display-p3 1 0 0)', 'rgb(999,0,0)', '#badhex', 'rgb(1,2,3 / 1)']) assert.equal(normalizeColor(raw), null);
});

// Exported contracts retain explicit expectation shapes instead of executable expressions.
const unsupportedRule: Rule = { id: 'UNSUPPORTED', category: 'layout', status: 'proposed', reason: 'Needs approval.', expectation: { kind: 'unsupported', expression: 'not executable' } };
test('a proposed expression is data only', () => {
  const input = fixture(); input.baseline.rules.push(unsupportedRule);
  assert.equal(audit(input).summary.counts.proposed, 2);
});
