import { createHash } from 'node:crypto';
import { FINDING_STATUSES } from './contracts.js';
import type { AuditInput, AuditReport, Finding, FindingStatus, Observation, Rule, Run } from './contracts.js';
import { normalizeObserved, resolveExpected, sameValue } from './normalize.js';
import { validateInput } from './validation.js';

const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const compareText = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export function applicable(rule: Rule, run: Run): boolean {
  const condition = rule.condition;
  return (!condition?.themes || condition.themes.includes(run.theme))
    && (condition?.minWidthExclusive === undefined || run.viewport.width > condition.minWidthExclusive)
    && (condition?.maxWidth === undefined || run.viewport.width <= condition.maxWidth);
}
function finding(input: AuditInput, rule: Rule, run: Run, observation: Observation | undefined, status: FindingStatus, reason: string): Finding {
  const source = rule.source ? input.baseline.sources.find(source => source.id === rule.source!.id)! : null;
  return {
    id: hash([run.id, rule.id, observation?.element ?? null]),
    runId: run.id, ruleId: rule.id, category: rule.category, status,
    pageUrl: run.pageUrl, viewport: run.viewport, theme: run.theme,
    selector: rule.selector ?? null, property: rule.property ?? null, element: observation?.element ?? null,
    source: source && rule.source ? { ...source, anchor: rule.source.anchor } : null,
    expectation: rule.expectation ?? null, observedValue: observation?.value ?? null,
    expected: null, actual: null, reason, recommendation: rule.recommendation ?? null,
    evidence: observation?.evidence ?? null, position: observation?.position ?? null,
  };
}
export function audit(value: unknown): AuditReport {
  const input = validateInput(value);
  const findings: Finding[] = [];
  for (const run of [...input.runs].sort((a, b) => compareText(a.id, b.id))) {
    for (const rule of [...input.baseline.rules].sort((a, b) => compareText(a.id, b.id))) {
      if (!applicable(rule, run)) {
        findings.push(finding(input, rule, run, undefined, 'not-applicable', 'Outside the documented rule condition.'));
        continue;
      }
      if (rule.status !== 'established') {
        findings.push(finding(input, rule, run, undefined, rule.status, rule.reason!));
        continue;
      }
      if (run.status === 'failed') {
        findings.push(finding(input, rule, run, undefined, 'unchecked', `Capture failed: ${run.reason}`));
        continue;
      }
      const observations = run.observations.filter(obs => obs.ruleId === rule.id).sort((a, b) => compareText(a.element, b.element));
      if (!observations.length) {
        const absent = input.baseline.scope === 'documented-visual' && run.capture?.enumeration.some(entry => entry.ruleId === rule.id && entry.matched === 0);
        findings.push(finding(input, rule, run, undefined, absent ? 'not-applicable' : 'unchecked', absent ? 'This component is absent in the captured page; there is no visible styling to compare.' : 'No observation supplied for this applicable rule.'));
        continue;
      }
      for (const obs of observations) {
        if (input.baseline.scope === 'documented-visual' && input.evidenceKind === 'local-capture' && obs.state === 'unsupported' && obs.reason === 'Element is not rendered in the selected static state.' && obs.bounds && (obs.bounds.width === 0 || obs.bounds.height === 0)) {
          findings.push(finding(input, rule, run, obs, 'not-applicable', 'This element is hidden at the selected width/theme; there is no visible styling to compare.'));
          continue;
        }
        const result = finding(input, rule, run, obs, 'unchecked', '');
        result.expected = resolveExpected(rule.expectation!, run.theme, run.viewport.width);
        if (input.evidenceKind === 'local-capture' && result.expected && obs.reference) {
          result.expected = normalizeObserved(obs.reference.value, rule.expectation!);
        }
        if (obs.state !== 'measured') result.reason = `Observation ${obs.state}: ${obs.reason}`;
        else if (!result.expected) result.reason = 'Expected expression or color is outside the supported comparison subset.';
        else {
          result.actual = normalizeObserved(obs.value!, rule.expectation!);
          if (!result.actual) result.reason = 'Observed value is outside the supported canonical CSS subset.';
          else {
            const conforms = rule.expectation!.kind === 'max-px' && result.expected.kind === 'px' && result.actual.kind === 'px' ? result.actual.value <= result.expected.value : sameValue(result.expected, result.actual);
            result.status = conforms ? 'pass' : 'mismatch';
            result.reason = rule.expectation!.kind === 'max-px' && result.status === 'pass' ? 'Does not exceed the documented maximum.' : result.status === 'pass' ? 'Matches the established rule exactly after normalization.' : 'Differs from the applicable established rule.';
          }
        }
        findings.push(result);
      }
    }
  }
  const counts = Object.fromEntries(FINDING_STATUSES.map(status => [status, 0])) as Record<FindingStatus, number>;
  for (const item of findings) counts[item.status]++;
  const checked = counts.pass + counts.mismatch;
  const incomplete = input.runs.some(run => (run.capture?.issues.length ?? 0) > 0) || input.baseline.coverage === 'partial' || checked === 0 || counts.unchecked + counts['missing-guidance'] + counts.ambiguous + counts.proposed > 0;
  const content: Omit<AuditReport, 'id'> = {
    schemaVersion: input.schemaVersion,
    evidenceKind: input.evidenceKind,
    baseline: { id: input.baseline.id, version: input.baseline.version, coverage: input.baseline.coverage, ...(input.baseline.scope ? { scope: input.baseline.scope } : {}), sources: [...input.baseline.sources].sort((a, b) => compareText(a.id, b.id)) },
    outcome: counts.mismatch ? 'mismatches' : incomplete ? 'incomplete' : 'checked-scope-pass',
    limitations: input.evidenceKind === 'synthetic' ? [
      'Synthetic fixture observations only. This report is not a portfolio audit.',
      'No browser capture, screenshot alignment, font loading or browser-rounding policy has been validated.',
      'The result describes supplied observations; selector matching and complete element enumeration are not verified in this slice.',
      ...(input.baseline.coverage === 'partial' ? ['The rule baseline is partial; zero mismatches cannot establish complete page conformance.'] : []),
    ] : input.baseline.scope === 'documented-visual' ? [
      'Only supported visual rules with documented or explicitly owner-approved expectations are compared.',
      'Visible styling only: typography, colors, spacing, borders, corners and documented dimensions/positioning. No general quality or design-system gap audit.',
      'Hidden or absent components are not applicable. Actual capture or measurement failures remain unchecked.',
      'Saved measurements and screenshots are reused from their recorded capture time; this is not a new live capture.',
      'Coverage is limited to mapped rules, selected widths, both themes and the recorded Chromium. It is not exhaustive page conformance.',
    ] : [
      'Local browser capture against a partial explicit rule set; not complete page conformance.',
      'Expected CSS is resolved in an independent reference page in the same browser and viewport; no numeric tolerance is applied.',
      'Main-document light DOM selectors only. Hidden elements, frames, shadow DOM and interaction states are not completely audited.',
      'Full-page screenshot is a single capture at scroll zero; sticky/fixed behavior at other scroll positions is not tested.',
      'Source snapshot age and unresolved design guidance remain visible in baseline provenance; no live refresh is implied.',
    ],
    ... (input.evidenceKind === 'local-capture' ? { captures: input.runs.map(run => ({ runId: run.id, metadata: run.capture! })) } : {}),
    summary: { total: findings.length, checked, counts },
    findings,
  };
  return { id: hash(content), ...content };
}
