import type { IntakeRule, IntakeSource } from './intake.js';
import type { Mapping } from './openrouter.js';
import type { WebReport, WebTarget } from './web-audit.js';

export type SavedSystem = {
  id: string;
  name: string;
  rules: IntakeRule[];
  sourceIds: string[];
  version: 1;
  schemaVersion: 'design-system-1';
  createdAt: string;
  auditProperties: string[];
};
export type Job = { id: string; state: 'running' | 'done' | 'failed'; message: string; startedAt: number; result?: unknown };
export type SavedReport = { id: string; url: string; report: WebReport; rules: IntakeRule[]; mappings: Mapping[] };
export type ProjectRecords = { source: Omit<IntakeSource, 'original'>; system: SavedSystem; target: WebTarget; job: Job; report: SavedReport };
export type RecordKind = keyof ProjectRecords;
export type RecordSummary = { id: string; kind: 'system' | 'report'; name?: string; url?: string; created_at: string };
export interface ProjectStore {
  get<K extends RecordKind>(kind: K, id: string): Promise<ProjectRecords[K] | undefined>;
  put<K extends RecordKind>(kind: K, record: ProjectRecords[K]): Promise<void>;
  updateJob(job: Job): Promise<void>;
  count(kind: RecordKind): Promise<number>;
  library(): Promise<RecordSummary[]>;
  upload(name: string, bytes: Buffer, contentType: string): Promise<void>;
  download(name: string): Promise<Buffer | undefined>;
  removeFiles(names: string[]): Promise<void>;
}
