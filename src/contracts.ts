/** Version 1 offline contracts. Synthetic evidence never proves portfolio conformance. */
export const SCHEMA_VERSION = '1.0' as const;
export const CAPTURE_SCHEMA_VERSION = '1.1' as const;
export const EXPANDED_SCHEMA_VERSION = '1.2' as const;
export type SchemaVersion = typeof SCHEMA_VERSION | typeof CAPTURE_SCHEMA_VERSION | typeof EXPANDED_SCHEMA_VERSION;
export type EvidenceKind = 'synthetic' | 'local-capture';
export const CATEGORIES = ['colors', 'typography', 'spacing', 'borders-radii', 'layout'] as const;
export type Category = typeof CATEGORIES[number];
export type Theme = 'dark' | 'light';
export type RuleStatus = 'established' | 'proposed' | 'missing-guidance' | 'ambiguous' | 'deferred';
export type FontSizeExpectation = { kind: 'px'; value: number } | { kind: 'clamp-vw'; min: number; vw: number; max: number };
export type Expectation =
  | { kind: 'color'; value: string | { dark: string; light: string } }
  | { kind: 'px'; value: number }
  | { kind: 'clamp-vw'; min: number; vw: number; max: number }
  | { kind: 'max-px'; value: number }
  | { kind: 'number'; value: number }
  | { kind: 'keyword'; value: string }
  | { kind: 'font-family'; value: string; aliases?: string[] }
  | { kind: 'font-relative'; factor: number; fontSize: FontSizeExpectation }
  | { kind: 'unsupported'; expression: string };
export interface Source {
  id: string;
  url: string;
  snapshot: string;
  sha256: string;
}
export interface Rule {
  id: string;
  category: Category;
  status: RuleStatus;
  selector?: string;
  property?: string;
  source?: { id: string; anchor: string };
  condition?: { minWidthExclusive?: number; maxWidth?: number; themes?: Theme[] };
  expectation?: Expectation;
  reason?: string;
  recommendation?: string;
}
export interface Observation {
  ruleId: string;
  element: string;
  state: 'measured' | 'unsupported' | 'failed';
  value?: string | number;
  reason?: string;
  evidence?: string;
  position?: { x: number; y: number };
  reference?: { expression: string; value: string | number };
  bounds?: { width: number; height: number };
}
export interface CaptureMetadata {
  capturedAt: string;
  browser: string;
  allowedOrigin: string;
  finalUrl: string;
  requestedViewport: { width: number; height: number; deviceScaleFactor: number };
  achievedTheme: Theme | null;
  fontsReady: boolean;
  document: { width: number; height: number };
  screenshot?: { path: string; sha256: string; width: number; height: number; kind: 'full-page' };
  enumeration: { ruleId: string; matched: number; hidden: number }[];
  issues: string[];
  scrollSteps: number;
  measurement: 'browser-reference-v1' | 'browser-reference-v2';
}
export interface Run {
  id: string;
  pageUrl: string;
  viewport: { width: number; height: number; deviceScaleFactor: number };
  theme: Theme;
  status: 'captured' | 'failed';
  reason?: string;
  observations: Observation[];
  capture?: CaptureMetadata;
}
export interface AuditInput {
  schemaVersion: SchemaVersion;
  evidenceKind: EvidenceKind;
  baseline: {
    id: string;
    version: string;
    coverage: 'partial' | 'declared-rules';
    scope?: 'documented-visual';
    sources: Source[];
    rules: Rule[];
  };
  runs: Run[];
}
export type Normalized = { kind: 'rgba'; value: [number, number, number, number] } | { kind: 'px'; value: number } | { kind: 'number'; value: number } | { kind: 'text'; value: string };
export const FINDING_STATUSES = ['pass', 'mismatch', 'unchecked', 'missing-guidance', 'ambiguous', 'proposed', 'deferred', 'not-applicable'] as const;
export type FindingStatus = typeof FINDING_STATUSES[number];
export interface Finding {
  id: string;
  runId: string;
  ruleId: string;
  category: Category;
  status: FindingStatus;
  pageUrl: string;
  viewport: Run['viewport'];
  theme: Theme;
  selector: string | null;
  property: string | null;
  element: string | null;
  source: (Source & { anchor: string }) | null;
  expectation: Expectation | null;
  observedValue: string | number | null;
  expected: Normalized | null;
  actual: Normalized | null;
  reason: string;
  recommendation: string | null;
  evidence: string | null;
  position: Observation['position'] | null;
}
export interface AuditReport {
  schemaVersion: SchemaVersion;
  id: string;
  evidenceKind: EvidenceKind;
  baseline: { id: string; version: string; coverage: AuditInput['baseline']['coverage']; scope?: 'documented-visual'; sources: Source[] };
  outcome: 'mismatches' | 'incomplete' | 'checked-scope-pass';
  limitations: string[];
  summary: { total: number; checked: number; counts: Record<FindingStatus, number> };
  findings: Finding[];
  captures?: { runId: string; metadata: CaptureMetadata }[];
}
