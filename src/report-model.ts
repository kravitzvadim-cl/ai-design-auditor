import type { AuditReport, CaptureMetadata, Rule, Run } from './contracts.js';

export interface VisualRun {
  id: string;
  pageUrl: string;
  viewport: Run['viewport'];
  theme: Run['theme'];
  status: Run['status'];
  reason: string | null;
  capture: CaptureMetadata | null;
  image: string | null;
}
export interface VisualData {
  title: string;
  report: AuditReport;
  rules: Rule[];
  runs: VisualRun[];
  locations: Record<string, { x: number; y: number; width: number; height: number }>;
  sources: { id: string; file: string }[];
}
