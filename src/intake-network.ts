import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { sourceFromText, htmlText, figmaRules } from './intake.js';
import type { IntakeSource } from './intake.js';

export function publicAddress(address: string): boolean {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a! >= 224 || (a === 169 && b === 254) || (a === 172 && b! >= 16 && b! <= 31) || (a === 192 && (b === 168 || b === 0)) || (a === 100 && b! >= 64 && b! <= 127) || a === 198);
  }
  // Only globally routed unicast IPv6. Reject mapped/private/local addresses.
  return isIP(address) === 6 && /^[23][a-f0-9]{0,3}:/i.test(address);
}
export function checkedUrl(raw: string): URL {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || (url.port && !['80', '443'].includes(url.port))) throw new Error('Use a public http/https link without embedded credentials or a custom port.');
  if (url.hostname.toLowerCase() === 'localhost' || (isIP(url.hostname.replace(/[\[\]]/g, '')) && !publicAddress(url.hostname.replace(/[\[\]]/g, '')))) throw new Error('Private/local addresses cannot be imported through this public-link reader. Upload a local export instead.');
  return url;
}
export async function fetchPublic(raw: string, headers: Record<string, string> = {}, redirects = 0): Promise<{ bytes: Buffer; type: string; finalUrl: string }> {
  const url = checkedUrl(raw); const hostname = url.hostname.replace(/[\[\]]/g, '');
  const records = await lookup(hostname, { all: true });
  if (!records.length || records.some(item => !publicAddress(item.address))) throw new Error('This link resolves to a private or unsupported network address. Upload an export instead.');
  const chosen = records[0]!;
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'GET', headers: { 'User-Agent': 'AI-Auditor-Local-Intake', ...headers }, agent: false, autoSelectFamily: false, lookup: (_host, _options, callback) => callback(null, chosen.address, chosen.family) } as import('node:http').RequestOptions & { autoSelectFamily: boolean }, response => {
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0)) {
        response.resume();
        if (redirects >= 3 || !response.headers.location) { reject(new Error('Too many redirects. Use a direct source link.')); return; }
        const destination = new URL(response.headers.location, url);
        // Authentication headers are never forwarded across origins.
        if (Object.keys(headers).length && destination.origin !== url.origin) { reject(new Error('Authenticated source redirected to another origin.')); return; }
        fetchPublic(destination.href, headers, redirects + 1).then(resolve, reject); return;
      }
      if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) { response.resume(); reject(new Error(`The source returned HTTP ${response.statusCode}. Check access or upload an export.`)); return; }
      const chunks: Buffer[] = []; let length = 0;
      response.on('data', (chunk: Buffer) => { length += chunk.length; if (length > 8_000_000) { response.destroy(); reject(new Error('This source is larger than 8 MB. Use a smaller export.')); } else chunks.push(chunk); });
      response.on('end', () => resolve({ bytes: Buffer.concat(chunks), type: String(response.headers['content-type'] ?? '').split(';')[0]!, finalUrl: url.href })); response.on('error', reject);
    });
    request.setTimeout(15000, () => request.destroy(new Error('The source took too long to respond. Try an export.'))); request.on('error', reject); request.end();
  });
}
export function figmaLocation(raw: string): { key: string; node: string | null } | null {
  const url = checkedUrl(raw);
  if (!['figma.com', 'www.figma.com'].includes(url.hostname)) return null;
  const match = /^\/(?:file|design)\/([a-zA-Z0-9_-]{5,100})(?:\/|$)/.exec(url.pathname);
  if (!match) throw new Error('Use a Figma file/design link, optionally with a selected frame.');
  const node = url.searchParams.get('node-id');
  if (node && !/^[0-9:-]{1,100}$/.test(node)) throw new Error('The Figma node identifier is invalid.');
  return { key: match[1]!, node: node?.replace(/-/g, ':') ?? null };
}
export async function readLink(raw: string, figmaToken = process.env.FIGMA_ACCESS_TOKEN): Promise<IntakeSource> {
  const url = checkedUrl(raw); const figma = figmaLocation(raw);
  if (figma) {
    const token = figmaToken;
    if (!token) return { ...sourceFromText(url.href, '', 'Figma', url.href, 'text/uri-list'), state: 'connection-required', message: 'Figma access is not connected on this computer. Configure FIGMA_ACCESS_TOKEN locally, then re-add this link, or upload an export. No file content has been read.' };
    const endpoint = figma.node ? `https://api.figma.com/v1/files/${figma.key}/nodes?ids=${encodeURIComponent(figma.node)}` : `https://api.figma.com/v1/files/${figma.key}`;
    const result = await fetchPublic(endpoint, { 'X-Figma-Token': token });
    const source = sourceFromText(url.href, '', 'Figma', result.bytes.toString('base64'), 'application/json', 'base64'); source.rules = figmaRules(JSON.parse(result.bytes.toString('utf8')), source.id); source.state = source.rules.length ? 'read' : 'needs-review'; source.message = `${source.rules.length} text-style suggestions found. Review intended roles before saving. Mixed text ranges and non-solid fills are not flattened into exact rules.`; return source;
  }
  const result = await fetchPublic(url.href);
  const text = result.bytes.toString('utf8');
  if (/html/.test(result.type)) return sourceFromText(url.href, htmlText(text), 'Website', result.bytes.toString('base64'), result.type, 'base64');
  if (/text|json|xml/.test(result.type) || /\.(md|css|json|txt|csv)$/i.test(url.pathname)) return sourceFromText(url.href, text, 'Link', result.bytes.toString('base64'), result.type, 'base64');
  const { readAsset } = await import('./intake.js');
  return readAsset(decodeURIComponent(url.pathname.split('/').pop() || 'source'), result.bytes, result.type);
}
