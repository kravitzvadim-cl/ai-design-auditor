import type { Expectation, Normalized, Theme } from './contracts.js';

/** Limited CSS subset on purpose: unsupported values remain unchecked. */
export function normalizeColor(raw: string | number): Normalized | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim().toLowerCase();
  const hex = /^#([a-f0-9]{3,4}|[a-f0-9]{6}|[a-f0-9]{8})$/.exec(value)?.[1];
  if (hex) {
    const expanded = hex.length < 5 ? [...hex].map(char => char + char).join('') : hex;
    return { kind: 'rgba', value: [parseInt(expanded.slice(0, 2), 16), parseInt(expanded.slice(2, 4), 16), parseInt(expanded.slice(4, 6), 16), expanded.length === 8 ? parseInt(expanded.slice(6, 8), 16) / 255 : 1] };
  }
  if (value === 'transparent') return { kind: 'rgba', value: [0, 0, 0, 0] };
  const rgb = /^(rgb|rgba)\(([^()]*)\)$/.exec(value);
  if (!rgb) return null;
  const body = rgb[2]!;
  let parts: string[];
  let alpha = '1';
  if (body.includes(',')) {
    if (body.includes('/')) return null;
    parts = body.split(',').map(part => part.trim());
    if (parts.length === 4) alpha = parts.pop()!;
  } else {
    const split = body.split('/');
    if (split.length > 2) return null;
    parts = split[0]!.trim().split(/\s+/);
    if (split[1] !== undefined) alpha = split[1].trim();
  }
  if (parts.length !== 3) return null;
  const component = (text: string, maximum: number): number | null => {
    if (!/^(?:\d+(?:\.\d*)?|\.\d+)%?$/.test(text)) return null;
    const result = text.endsWith('%') ? Number(text.slice(0, -1)) * maximum / 100 : Number(text);
    return Number.isFinite(result) && result >= 0 && result <= maximum ? result : null;
  };
  const channels = parts.map(part => component(part, 255)); const opacity = component(alpha, 1);
  if (channels.some(channel => channel === null) || opacity === null) return null;
  return { kind: 'rgba', value: [channels[0]!, channels[1]!, channels[2]!, opacity] as [number, number, number, number] };
}
export function normalizePixels(raw: string | number, signed = false): Normalized | null {
  if (typeof raw === 'number') return Number.isFinite(raw) && (signed || raw >= 0) ? { kind: 'px', value: raw } : null;
  const match = /^(?:-?(?:\d+(?:\.\d*)?|\.\d+))px$/.exec(raw.trim());
  const value = match ? Number(match[0].slice(0, -2)) : NaN;
  return Number.isFinite(value) && (signed || value >= 0) ? { kind: 'px', value } : null;
}
/** Evaluate decimal vw as a decimal rational, converting to Number only once. No tolerance. */
function viewportLength(vw: number, width: number): number {
  const [mantissa, exponent = '0'] = String(vw).split('e');
  const [whole, fraction = ''] = mantissa!.split('.');
  const product = BigInt(whole! + fraction) * BigInt(width);
  return Number(`${product}e${Number(exponent) - fraction.length - 2}`);
}
function decimalProduct(a: number, b: number): number {
  const parts = (n: number): [bigint, number] => {
    const [mantissa, exponent = '0'] = String(n).split('e');
    const [whole, fraction = ''] = mantissa!.split('.');
    return [BigInt(whole! + fraction), Number(exponent) - fraction.length];
  };
  const [an, ae] = parts(a); const [bn, be] = parts(b);
  return Number(`${an * bn}e${ae + be}`);
}
export function resolveExpected(expectation: Expectation, theme: Theme, width: number): Normalized | null {
  switch (expectation.kind) {
    case 'color': return normalizeColor(typeof expectation.value === 'string' ? expectation.value : expectation.value[theme]);
    case 'px': case 'max-px': return { kind: 'px', value: expectation.value };
    case 'number': return { kind: 'number', value: expectation.value };
    case 'keyword': return { kind: 'text', value: expectation.value.toLowerCase() };
    case 'font-family': return { kind: 'text', value: expectation.value.toLowerCase() };
    case 'font-relative': {
      const size = resolveExpected(expectation.fontSize, theme, width);
      return size?.kind === 'px' ? { kind: 'px', value: decimalProduct(size.value, expectation.factor) } : null;
    }
    case 'clamp-vw': return { kind: 'px', value: Math.min(expectation.max, Math.max(expectation.min, viewportLength(expectation.vw, width))) };
    case 'unsupported': return null;
  }
}
export function sameValue(a: Normalized, b: Normalized): boolean {
  if (a.kind === 'px' && b.kind === 'px') return a.value === b.value;
  if (a.kind === 'number' && b.kind === 'number') return a.value === b.value;
  if (a.kind === 'text' && b.kind === 'text') return a.value === b.value;
  if (a.kind === 'rgba' && b.kind === 'rgba') return a.value.every((channel, index) => channel === b.value[index]);
  return false;
}

/** Source-derived CSS only. Never copy a target's style to form an expected value. */
export function expectationCss(expectation: Expectation, theme: Theme): string | null {
  switch (expectation.kind) {
    case 'color': {
      const value = typeof expectation.value === 'string' ? expectation.value : expectation.value[theme];
      return normalizeColor(value) ? value : null;
    }
    case 'px': case 'max-px': return `${expectation.value}px`;
    case 'number': return String(expectation.value);
    case 'keyword': return expectation.value;
    case 'font-family': return JSON.stringify(expectation.value);
    case 'font-relative': return `calc(${expectation.factor} * ${expectationCss(expectation.fontSize, theme)})`;
    case 'clamp-vw': return `clamp(${expectation.min}px, ${expectation.vw}vw, ${expectation.max}px)`;
    case 'unsupported': return null;
  }
}

/** A computed family list checks configured primary family, not per-glyph font usage. */
export function normalizeObserved(raw: string | number, expectation: Expectation): Normalized | null {
  if (expectation.kind === 'color') return normalizeColor(raw);
  if (expectation.kind === 'number') {
    const value = typeof raw === 'number' ? raw : /^\d+(?:\.\d+)?$/.test(raw.trim()) ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 0 ? { kind: 'number', value } : null;
  }
  if (expectation.kind === 'keyword') return typeof raw === 'string' && /^[a-z-]+$/i.test(raw.trim()) ? { kind: 'text', value: raw.trim().toLowerCase() } : null;
  if (expectation.kind === 'font-family') {
    if (typeof raw !== 'string') return null;
    const primary = raw.split(',')[0]!.trim().replace(/^(['"])(.*)\1$/, '$2').toLowerCase();
    if (!/^[a-z][a-z0-9 -]*$/.test(primary)) return null;
    const aliases = [expectation.value, ...(expectation.aliases ?? [])].map(item => item.toLowerCase());
    return { kind: 'text', value: aliases.includes(primary) ? expectation.value.toLowerCase() : primary };
  }
  if (expectation.kind === 'unsupported') return null;
  return normalizePixels(raw, expectation.kind === 'font-relative');
}
