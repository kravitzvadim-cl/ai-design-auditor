import { createServer } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { sourceFromText, readAsset, validColor, validSize } from './intake.js';
import type { IntakeSource, IntakeRule } from './intake.js';
import { readLink } from './intake-network.js';
import { createCaptureDirectory } from './io.js';
import { intakeHTML } from './intake-view.js';
import { CheapInterpreter, CHEAP_MODEL } from './openrouter.js';
import type { Mapping } from './openrouter.js';
import { inspectWebsite, compareWebsite, saveWebReport, screenshotBytes } from './web-audit.js';
import type { WebTarget } from './web-audit.js';

type SavedSystem = { id: string; name: string; rules: IntakeRule[] };
type Job = { id: string; state: 'running'|'done'|'failed'; message: string; result?: unknown };
export type IntakeServices = { interpreter?: CheapInterpreter; inspect?: typeof inspectWebsite };

export function intakeServer(directory = process.cwd(), services: IntakeServices = {}) {
  const sources = new Map<string, IntakeSource>();
  const systems = new Map<string,SavedSystem>(); const targets = new Map<string,WebTarget>(); const jobs = new Map<string,Job>();
  const ai = services.interpreter ?? new CheapInterpreter(); let active = false;
  function job(action: () => Promise<unknown>, message: string) {
    if(active) throw new Error('Another task is running. Wait for it to finish.');
    if(jobs.size>=30) throw new Error('Session task limit reached. Save your work before restarting.');
    const item:Job={id:randomUUID(),state:'running',message};jobs.set(item.id,item);active=true;
    void action().then(result=>{item.state='done';item.result=result;item.message='Completed.';}).catch(error=>{item.state='failed';item.message=error instanceof Error?error.message:'This task failed. Try again.';}).finally(()=>{active=false;});return item;
  }
  return createServer(async (request, response) => {
    const host = request.headers.host ?? ''; const origin = `http://${host}`;
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      if (!/^127\.0\.0\.1:\d+$/.test(host)) { send(403, { error: 'Use the localhost application address.' }); return; }
      const path = new URL(request.url ?? '/', origin).pathname;
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.method === 'GET' && path === '/') { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(intakeHTML); return; }
      if (request.method === 'GET' && ['/intake-client.js','/web-audit-client.js'].includes(path)) { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(await readFile(new URL('.'+path, import.meta.url))); return; }
      if (request.method === 'GET' && path === '/api/status') { send(200, { figma: !!process.env.FIGMA_ACCESS_TOKEN, ai: ai.configured, model: CHEAP_MODEL, budget: ai.budget }); return; }
      if(request.method==='GET' && /^\/api\/jobs\/[a-f0-9-]{36}$/.test(path)){ const item=jobs.get(path.split('/').pop()!);send(item?200:404,item??{error:'Unknown task.'});return; }
      if(request.method==='GET' && /^\/api\/screenshots\/[a-f0-9-]{36}\/(light|dark)-(390|1440)$/.test(path)) {
        const [, , , id, captureId]=path.split('/');const target=targets.get(id!);if(!target)throw new Error('Unknown target.');
        const bytes=await screenshotBytes(target,captureId!,directory);response.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});response.end(bytes);return;
      }
      if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') { send(403, { error: 'This action must come from the local application.' }); return; }
      let length = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { length += chunk.length; if (length > 12_000_000) throw new Error('Request is too large. Upload one file at a time, under 8 MB.'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (path === '/api/import') {
        if (sources.size >= 30) throw new Error('This session contains 30 sources. Save your system, then restart for another session.');
        let source: IntakeSource;
        if (input.type === 'link' && typeof input.value === 'string') source = await readLink(input.value);
        else if (input.type === 'text' && typeof input.value === 'string' && input.value.trim()) source = sourceFromText(typeof input.name === 'string' ? input.name : 'Pasted guidelines', input.value);
        else if (input.type === 'file' && typeof input.name === 'string' && typeof input.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) source = await readAsset(input.name, Buffer.from(input.data, 'base64'), typeof input.mediaType === 'string' ? input.mediaType : 'application/octet-stream');
        else throw new Error('Add a link, a file or some guidelines first.');
        sources.set(source.id, source); const { original: _original, ...publicSource } = source; send(200, publicSource); return;
      }
      if(path==='/api/interpret') {
        const source=sources.get(String(input.sourceId));if(!source)throw new Error('Add this source again before interpreting it.');
        if(!ai.configured)throw new Error('OpenRouter is not connected. Add the key locally and restart the app.');
        send(202,job(async()=>{const result=await ai.extract(source);return {sourceId:source.id,...result};},'Interpreting the documented text sizes and colors…'));return;
      }
      if(path==='/api/inspect') {
        if(!systems.has(String(input.systemId)))throw new Error('Save your reviewed design system first.');
        if(typeof input.url!=='string')throw new Error('Add a public website URL.');
        const themes=input.themes;
        if(!Array.isArray(themes)||!themes.length||themes.length>2||themes.some(t=>!['light','dark'].includes(String(t)))||new Set(themes).size!==themes.length)throw new Error('Choose light, dark or both browser preferences.');
        if(targets.size>=5)throw new Error('This session already has five page captures. Save your results before restarting.');
        send(202,job(async()=>{const target=await (services.inspect??inspectWebsite)(String(input.url),directory,themes as ('light'|'dark')[],undefined,systems.get(String(input.systemId))!.rules.map(r=>r.size).filter(Boolean));targets.set(target.id,target);return {id:target.id,url:target.url,candidates:target.candidates,captures:target.captures.map(c=>({id:c.id,width:c.width,theme:c.theme,issues:c.issues,truncated:c.truncated}))};},'Capturing the selected page at mobile and desktop widths…'));return;
      }
      if(path==='/api/map') {
        const system=systems.get(String(input.systemId)),target=targets.get(String(input.targetId));if(!system||!target)throw new Error('Save your rules and capture a target first.');
        if(!ai.configured)throw new Error('OpenRouter is not connected. Select mappings manually or configure your local key.');
        send(202,job(()=>ai.map(system.rules,target.candidates),'Suggesting which rules apply to the captured text…'));return;
      }
      if(path==='/api/audit') {
        const system=systems.get(String(input.systemId)),target=targets.get(String(input.targetId));if(!system||!target||!Array.isArray(input.mappings)||input.mappings.length>200||input.reviewed!==true)throw new Error('Review your rule-to-element mappings before auditing.');
        const mappings=input.mappings as Mapping[];
        const report=compareWebsite(target,system.rules,mappings);if(!report.checked&&!report.unchecked.length)throw new Error('No selected mappings apply in these captures. Choose the relevant elements, themes and widths.');
        await saveWebReport(report,target,system.rules,mappings,directory);send(200,report);return;
      }
      if (path === '/api/save') {
        if (input.reviewed !== true) throw new Error('Review the rules before saving.');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Give your design system a name, up to 120 characters.');
        if (!Array.isArray(input.rules) || !input.rules.length || input.rules.length > 200) throw new Error('Review at least one rule before saving (maximum 200).');
        const reviewed: IntakeRule[] = input.rules.map((value: unknown) => {
          if (!value || typeof value !== 'object') throw new Error('Invalid rule.');
          const rule = value as Record<string, unknown>;
          if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 160 || typeof rule.size !== 'string' || typeof rule.color !== 'string' || (rule.size && !validSize(rule.size)) || (rule.color && !validColor(rule.color)) || (!rule.size && !rule.color) || !['all', 'light', 'dark'].includes(String(rule.theme)) || (rule.sourceId !== 'manual' && !sources.has(String(rule.sourceId)))) throw new Error('Each rule needs a name and a valid text size or color. Check its source and theme.');
          const result: IntakeRule = { id: randomUUID(), name: rule.name.trim(), size: rule.size, color: rule.color, theme: rule.theme as IntakeRule['theme'], sourceId: String(rule.sourceId), evidence: typeof rule.evidence === 'string' ? rule.evidence.slice(0, 600) : 'Owner-entered rule' };
          for(const key of ['aboveWidth','maxWidth'] as const) if(rule[key]!==undefined){if(typeof rule[key]!=='number'||!Number.isInteger(rule[key])||rule[key]<0||rule[key]>10000)throw new Error('Width conditions must be whole pixels between 0 and 10,000.');result[key]=rule[key];}
          if(result.aboveWidth!==undefined&&result.maxWidth!==undefined&&result.aboveWidth>=result.maxWidth)throw new Error('The lower width must be below the upper width.');
          if(typeof rule.conditionEvidence==='string')result.conditionEvidence=rule.conditionEvidence.slice(0,600);return result;
        });
        for(let i=0;i<reviewed.length;i++)for(const other of reviewed.slice(i+1)) {
          const rule=reviewed[i]!;const overlaps=rule.name.toLowerCase()===other.name.toLowerCase()&&(rule.theme===other.theme||rule.theme==='all'||other.theme==='all')&&Math.max(rule.aboveWidth??-1,other.aboveWidth??-1)<Math.min(rule.maxWidth??Infinity,other.maxWidth??Infinity);
          if(overlaps&&((rule.size&&other.size&&rule.size!==other.size)||(rule.color&&other.color&&rule.color!==other.color)))throw new Error(`Conflicting size or color for ${rule.name}. Separate its theme/width usage or remove the duplicate.`);
        }
        const attached = input.sourceIds === undefined ? [] : input.sourceIds;
        if (!Array.isArray(attached) || attached.length > 30 || attached.some(id => typeof id !== 'string' || !sources.has(id))) throw new Error('One of the attached sources is no longer in this session. Add it again.');
        const id = randomUUID(); const version = { schemaVersion: 'design-system-1', id, version: 1, name: input.name.trim(), createdAt: new Date().toISOString(), auditProperties: ['font-size', 'color'], rules: reviewed, sources: [...new Set([...reviewed.map(r => r.sourceId), ...attached as string[]])].filter(id => id !== 'manual').map(id => sources.get(id)!) };
        const folder = await createCaptureDirectory(`reports/design-systems/${id}`, directory); await writeFile(join(folder, 'system.json'), JSON.stringify(version, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        systems.set(version.id,{id:version.id,name:version.name,rules:version.rules});
        const { sources: privateSources, ...publicVersion } = version;
        send(200, { ...publicVersion, sourceCount: privateSources.length, savedPath: `reports/design-systems/${id}/system.json` }); return;
      }
      send(404, { error: 'Unknown action.' });
    } catch (error) { send(400, { error: error instanceof Error ? error.message : 'This source could not be read.' }); }
  });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.INTAKE_PORT ?? '4341');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid INTAKE_PORT.');
  intakeServer().listen(port, '127.0.0.1', () => process.stdout.write(`Design-system intake: http://127.0.0.1:${port}/\n`));
}
