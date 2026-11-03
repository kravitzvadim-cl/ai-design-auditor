import { isLoopbackUrl } from './validation.js';

export const CORE_WIDTHS = [390, 819, 820, 821, 1079, 1080, 1081, 1440, 1920] as const;
/** Literal loopback only for capture: avoids relying on arbitrary hostname resolution. */
export function captureTarget(raw: string): URL {
  const target = new URL(raw);
  if (!isLoopbackUrl(raw) || !['127.0.0.1', '[::1]'].includes(target.hostname) || target.hash) throw new Error('Capture needs a literal 127.0.0.1 or [::1] HTTP(S) URL, without credentials or fragment.');
  return target;
}
export function requestAllowed(raw: string, method: string, navigation: boolean, mainFrame: boolean, target: URL): boolean {
  try {
    const request = new URL(raw);
    if (!['GET', 'HEAD'].includes(method) || !['http:', 'https:'].includes(request.protocol) || request.username || request.password || request.origin !== target.origin) return false;
    return !navigation || (mainFrame && request.href === target.href);
  } catch { return false; }
}

/** Request queries can contain local preview/session tokens. Keep them out of saved diagnostics. */
export function diagnosticMessage(message: string): string {
  return message.replace(/(?:https?|wss?):\/\/[^\s<>"')]+/g, raw => {
    try { const url = new URL(raw); return `${url.origin}${url.pathname}`; } catch { return '[URL omitted]'; }
  }).slice(0, 1000);
}
