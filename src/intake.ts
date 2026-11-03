import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { normalizeColor } from './normalize.js';

export type IntakeRule = { id: string; name: string; size: string; color: string; theme: 'all' | 'light' | 'dark'; sourceId: string; evidence: string; aboveWidth?: number; maxWidth?: number; conditionEvidence?: string };
export type IntakeSource = { id: string; name: string; kind: string; state: 'read' | 'needs-review' | 'connection-required'; message: string; text: string; sha256: string; rules: IntakeRule[]; original: string; originalEncoding: 'utf8' | 'base64'; mediaType: string };
const run = promisify(execFile);
export const MAX_ASSET = 8_000_000;
export function validSize(value: string): boolean { return /^(?:\d+(?:\.\d+)?|\.\d+)(px|em|rem|pt|sp)$/.test(value) && Number.parseFloat(value) > 0 && Number.parseFloat(value) <= 1000; }
export function validColor(value: string): boolean { return normalizeColor(value) !== null; }
const sizePattern = /\b(?:\d+(?:\.\d+)?|\.\d+)\s*(?:px|rem|em|pt|sp)\b/i;
const colorPattern = /#[a-f\d]{6}(?:[a-f\d]{2})?\b|#[a-f\d]{3,4}\b|rgba?\([^()]+\)/i;
export function extractRules(text: string, sourceId: string): IntakeRule[] {
  const result: IntakeRule[] = [];
  const add = (name: string, size: string, color: string, evidence: string, theme: IntakeRule['theme'] = 'all') => {
    name = name.replace(/^[#*\s|]+|[|\s]+$/g, '').slice(0, 160).trim(); size = size.replace(/\s/g, '').toLowerCase();
    if (!name || (!validSize(size) && !validColor(color))) return;
    const rule = { id: randomUUID(), name, size: validSize(size) ? size : '', color: validColor(color) ? color : '', theme, sourceId, evidence: evidence.slice(0, 600) };
    if (!result.some(item => item.name === rule.name && item.size === rule.size && item.color === rule.color)) result.push(rule);
  };
  // Explicit CSS properties, not appearance sampled from a live page.
  for (const match of text.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const body = match[2]!; const size = /(?:^|;)\s*font-size\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? '';
    const color = /(?:^|;)\s*color\s*:\s*([^;]+)/i.exec(body)?.[1]?.trim() ?? '';
    if (size || color) add(match[1]!.trim(), size, color, match[0]);
    for (const variable of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+)/gi)) {
      const key = variable[1]!; const val = variable[2]!.trim();
      if (/font.*size|size.*font/i.test(key) && validSize(val)) add(key, val, '', variable[0]);
      if (/text.*color|color.*text|foreground|--fg$/i.test(key) && validColor(val)) add(key, '', val, variable[0]);
    }
  }
  try {
    const walk = (value: unknown, path: string, depth = 0) => {
      if (depth > 16 || !value || typeof value !== 'object') return;
      if (Array.isArray(value)) { value.slice(0, 200).forEach((child, i) => walk(child, `${path} ${i + 1}`, depth + 1)); return; }
      const obj = value as Record<string, unknown>;
      const size = obj.fontSize ?? obj['font-size'] ?? obj.size; const color = obj.color ?? obj.textColor;
      if (typeof size === 'string' || typeof color === 'string') add(typeof obj.name === 'string' ? obj.name : path || 'Text style', typeof size === 'string' ? size : '', typeof color === 'string' ? color : '', JSON.stringify(obj), ['light', 'dark'].includes(String(obj.theme)) ? obj.theme as IntakeRule['theme'] : 'all');
      if (obj.$type === 'color' && typeof obj.$value === 'string') add(path, '', obj.$value, JSON.stringify(obj));
      if (obj.$type === 'dimension' && /font|size/i.test(path)) {
        const dim = obj.$value as { value?: unknown; unit?: unknown } | string;
        add(path, typeof dim === 'string' ? dim : dim && typeof dim === 'object' ? `${dim.value}${dim.unit}` : '', '', JSON.stringify(obj));
      }
      for (const [key, child] of Object.entries(obj)) if (!key.startsWith('$')) walk(child, path ? `${path} / ${key}` : key, depth + 1);
    };
    walk(JSON.parse(text), '');
  } catch { /* Not JSON; use explicit text/CSS readers. */ }
  // Labeled lines and table rows. No font size inferred from rendered pixels.
  for (const line of text.split(/\n/)) {
    if (line.length > 1000 || /[{}]/.test(line) || /clamp\(/i.test(line)) continue;
    // A prose number is not necessarily a text rule. Keep rejected properties,
    // breakpoint explanations and illustrative counterexamples out of suggestions.
    if (/line[ -]height|letter[ -]spacing|\btracking\b|\bbreakpoint\b|\brather than\b|\bfor example\b/i.test(line)) continue;
    if ([...line.matchAll(new RegExp(sizePattern.source, 'gi'))].length > 1 || [...line.matchAll(new RegExp(colorPattern.source, 'gi'))].length > 1) continue;
    const size = sizePattern.exec(line)?.[0] ?? ''; const color = colorPattern.exec(line)?.[0] ?? '';
    const firstValue = Math.min(...[size ? line.indexOf(size) : Infinity, color ? line.indexOf(color) : Infinity]);
    if (Number.isFinite(firstValue)) add(line.slice(0, firstValue).replace(/[|,:=\s-]+$/, ''), size, color, line);
  }
  return result.slice(0, 150);
}
export function sourceFromText(name: string, text: string, kind = 'Guidelines', original = text, mediaType = 'text/plain', originalEncoding: 'utf8' | 'base64' = 'utf8'): IntakeSource {
  if (Buffer.byteLength(original) > MAX_ASSET * 1.4 || text.length > 1_000_000) throw new Error('Source is too large. Use a smaller file or selected pages.');
  const id = randomUUID(); let rules = extractRules(text, id);
  try { const data = JSON.parse(text); if (data?.document?.type || data?.nodes) { rules = figmaRules(data, id); kind = 'Figma export'; } } catch { /* Other text sources. */ }
  return { id, name: name.slice(0, 200), kind, state: rules.length ? 'read' : 'needs-review', message: rules.length ? `${rules.length} suggestions found. Review the names, values and usage before saving.` : 'Source added. No explicit size or text-color rules were found. Add the rules below or provide a clearer source.', text: text.slice(0, 100_000), sha256: createHash('sha256').update(originalEncoding === 'base64' ? Buffer.from(original, 'base64') : original).digest('hex'), rules, original, originalEncoding, mediaType };
}
export async function readAsset(name: string, bytes: Buffer, mediaType: string): Promise<IntakeSource> {
  if (!bytes.length || bytes.length > MAX_ASSET) throw new Error('Choose a nonempty file smaller than 8 MB.');
  const extension = extname(name).toLowerCase();
  const textFile = ['.txt', '.md', '.markdown', '.json', '.css', '.csv', '.yaml', '.yml', '.html', '.htm', '.xml', '.svg'].includes(extension) || /^text\//.test(mediaType);
  if (textFile) {
    let text = bytes.toString('utf8');
    if (text.includes('\u0000') || text.includes('\ufffd')) return { ...sourceFromText(name, '', 'File', bytes.toString('base64'), mediaType, 'base64'), message: 'This file is not readable text. Add an export or enter its rules manually.' };
    if (['.html', '.htm'].includes(extension)) text = htmlText(text);
    return sourceFromText(name, text, extension === '.css' ? 'CSS' : 'File', bytes.toString('base64'), mediaType, 'base64');
  }
  const folder = await mkdtemp(join(tmpdir(), 'auditor-reader-')); const file = join(folder, `source${extension.replace(/[^.a-z0-9]/g, '').slice(0, 12)}`);
  try {
    await writeFile(file, bytes, { flag: 'wx' });
    let text = ''; let message = '';
    if (extension === '.pdf' || ['.png', '.jpg', '.jpeg', '.webp', '.tiff', '.bmp', '.heic'].includes(extension)) {
      const reader = join(process.cwd(), 'reports/runtime/asset-reader');
      try { const result = await run(reader, [file], { timeout: 30000, maxBuffer: 2_000_000 }); text = String(result.stdout); }
      catch { message = 'The local document/image reader could not read this source. You can still enter rules or add a text export.'; }
    } else if (['.docx', '.doc', '.rtf', '.odt'].includes(extension)) {
      try { const result = await run('/usr/bin/textutil', ['-convert', 'txt', '-stdout', file], { timeout: 15000, maxBuffer: 2_000_000 }); text = String(result.stdout); }
      catch { message = 'This document could not be read. Try a PDF/text export or enter its rules manually.'; }
    } else message = 'Source attached. This format needs an export or manually entered rules; its contents have not been interpreted.';
    const source = sourceFromText(name, text, extension === '.pdf' ? 'PDF' : /^image\//.test(mediaType) ? 'Image' : 'File', bytes.toString('base64'), mediaType, 'base64');
    if (message) source.message = message;
    if (source.kind === 'Image' || source.kind === 'PDF') source.message += ' Only written values are suggested; sizes are never guessed from appearance. Local reader limit: first 20 PDF pages.';
    return source;
  } finally { await rm(folder, { recursive: true, force: true }); }
}
export function htmlText(html: string): string {
  return html.replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<\/(?:td|th)>/gi, ' | ').replace(/<(?:br\s*\/?|\/(?:p|div|tr|li|h[1-6]|section))>/gi, '\n').replace(/<[^>]*>/g, ' ').replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/[ \t]+/g, ' ');
}
export function figmaRules(data: unknown, sourceId: string): IntakeRule[] {
  const rules: IntakeRule[] = [];
  const walk = (node: unknown, depth = 0) => {
    if (!node || typeof node !== 'object' || depth > 30 || rules.length >= 150) return;
    const item = node as Record<string, unknown>; const style = item.style as Record<string, unknown> | undefined;
    if (item.type === 'TEXT' && style) {
      const size = typeof style.fontSize === 'number' ? `${style.fontSize}px` : '';
      const fill = Array.isArray(item.fills) ? item.fills.find((f: Record<string, unknown>) => f.type === 'SOLID' && f.visible !== false) : undefined;
      const color = fill?.color as { r: number; g: number; b: number; a?: number } | undefined;
      const hex = color && [color.r, color.g, color.b].every(n => Number.isFinite(n) && n >= 0 && n <= 1) && (fill.opacity ?? 1) === 1 && (color.a ?? 1) === 1 ? '#' + [color.r, color.g, color.b].map(n => Math.round(n * 255).toString(16).padStart(2, '0')).join('') : '';
      // Mixed-range text is not one canonical text rule.
      if ((!Array.isArray(item.characterStyleOverrides) || item.characterStyleOverrides.every(value => value === 0)) && (validSize(size) || hex)) {
        const name = typeof item.name === 'string' ? item.name.slice(0, 160) : 'Text style';
        if (!rules.some(r => r.name === name && r.size === size && r.color === hex)) rules.push({ id: randomUUID(), name, size, color: hex, theme: 'all', sourceId, evidence: `Figma text layer ${String(item.id)}. Review its intended role before saving.` });
      }
    }
    if (Array.isArray(item.children)) item.children.forEach(child => walk(child, depth + 1));
  };
  const value = data as { document?: unknown; nodes?: Record<string, { document?: unknown }> };
  if (value?.document) walk(value.document);
  if (value?.nodes) Object.values(value.nodes).forEach(node => walk(node?.document));
  return rules;
}
