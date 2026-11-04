import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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
import { inspectWebsite, compareWebsite, matchPageText, saveWebReport, screenshotBytes } from './web-audit.js';
import type { WebTarget } from './web-audit.js';
import type { Job, ProjectStore, SavedSystem } from './project-store.js';
import { SupabaseUnavailable } from './supabase-workspace.js';

export type IntakeServices = { interpreter?: CheapInterpreter; inspect?: typeof inspectWebsite };
type ProjectRequest = { origin: string; path: string; store: ProjectStore };
const interruptedAfter = 5 * 60_000;

async function discardUncommittedFiles(store: ProjectStore, kind: 'source' | 'target', id: string, names: string[]) {
  if (!names.length) return;
  try {
    // A failed response can follow a successful commit. Read the record first.
    if (!await store.get(kind, id)) await store.removeFiles(names);
  } catch { process.stderr.write('Private evidence cleanup needs reconciliation.\n'); }
}

export function intakeHandler(directory = process.cwd(), services: IntakeServices = {}) {
  const sources = new Map<string, IntakeSource>();
  const systems = new Map<string, SavedSystem>();
  const targets = new Map<string, WebTarget>();
  const jobs = new Map<string, Job>();
  const ai = services.interpreter ?? new CheapInterpreter();
  let active = false;
  let writing = false;

  async function startJob(action: () => Promise<unknown>, message: string, store?: ProjectStore) {
    if (active) throw new Error('Another task is running. Wait for it to finish.');
    active = true;
    const item: Job = { id: randomUUID(), state: 'running', message, startedAt: Date.now() };
    try {
      if ((store ? await store.count('job') : jobs.size) >= 30) throw new Error('This workspace has reached its capture limit.');
      if (store) await store.put('job', item);
      else jobs.set(item.id, item);
    } catch (error) {
      active = false;
      throw error;
    }
    void (async () => {
      try {
        item.result = await action();
        item.state = 'done';
        item.message = 'Completed.';
      } catch (error) {
        item.state = 'failed';
        item.message = error instanceof Error ? error.message : 'This task failed. Try again.';
      }
      try { if (store) await store.updateJob(item); }
      catch { process.stderr.write('Could not save a private job result.\n'); }
      finally { active = false; }
    })();
    return item;
  }

  return async (request: import('node:http').IncomingMessage, response: import('node:http').ServerResponse, project?: ProjectRequest) => {
    const host = request.headers.host ?? '';
    const origin = project?.origin ?? `http://${host}`;
    const store = project?.store;
    const getSource = (id: string) => store ? store.get('source', id) : sources.get(id);
    const getSystem = (id: string) => store ? store.get('system', id) : systems.get(id);
    const getTarget = (id: string) => store ? store.get('target', id) : targets.get(id);
    let holdsWrite = false;
    const send = (status: number, body: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(body)); };
    try {
      if (!project && !/^127\.0\.0\.1:\d+$/.test(host)) { send(403, { error: 'Use the localhost application address.' }); return; }
      const path = project?.path ?? new URL(request.url ?? '/', origin).pathname;
      response.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'self'; frame-ancestors 'none'");
      response.setHeader('X-Content-Type-Options', 'nosniff');
      if (request.method === 'GET' && path === '/') { response.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); response.end(intakeHTML); return; }
      if (request.method === 'GET' && ['/intake-client.js','/web-audit-client.js'].includes(path)) { response.writeHead(200, { 'Content-Type': 'text/javascript' }); response.end(await readFile(new URL('.'+path, import.meta.url))); return; }
      if (request.method === 'GET' && path === '/api/status') { send(200, { privateWorkspace: !!store, figma: !store && !!process.env.FIGMA_ACCESS_TOKEN, ai: !store && ai.configured, model: CHEAP_MODEL, budget: ai.budget }); return; }
      if (request.method === 'GET' && path === '/api/library' && store) {
        send(200, { items: await store.library() });
        return;
      }
      if (request.method === 'GET' && store && /^\/api\/sources\/[a-f0-9-]{36}\/original$/.test(path)) {
        const id = path.split('/')[3]!;
        const source = await getSource(id);
        const bytes = source ? await store.download(`${id}.source`) : undefined;
        if (!source || !bytes) { send(404, { error: 'Original source not found.' }); return; }
        const filename = source.name.split(/[\\/]/).pop() || 'original-source';
        const encodedName = encodeURIComponent(Buffer.from(filename).toString()).replace(/['()*]/g, char => '%' + char.charCodeAt(0).toString(16));
        response.writeHead(200, {
          'Content-Type': 'application/octet-stream',
          'Content-Disposition': `attachment; filename="original-source"; filename*=UTF-8''${encodedName}`,
          'Cache-Control': 'no-store',
        });
        response.end(bytes);
        return;
      }
      if (request.method === 'GET' && store && /^\/api\/(systems|reports)\/[a-f0-9-]{36}$/.test(path)) {
        const [, , collection, id] = path.split('/');
        const record = collection === 'systems' ? await getSystem(id!) : await store.get('report', id!);
        if (!record) { send(404, { error: 'Saved work not found.' }); return; }
        if ('sourceIds' in record) {
          const savedSources = [];
          for (const sourceId of record.sourceIds) {
            const source = await store.get('source', sourceId);
            if (source) savedSources.push(source);
          }
          send(200, { ...record, sources: savedSources });
        } else send(200, record);
        return;
      }
      if (request.method === 'GET' && /^\/api\/jobs\/[a-f0-9-]{36}$/.test(path)) {
        const id = path.split('/').pop()!;
        let item = store ? await store.get('job', id) : jobs.get(id);
        if (store && item?.state === 'running' && Date.now() - item.startedAt > interruptedAfter) {
          item = { id, startedAt: item.startedAt, state: 'failed', message: 'This capture was interrupted. Start a new capture.' };
        }
        send(item ? 200 : 404, item ?? { error: 'Unknown task.' });
        return;
      }
      if (request.method === 'GET' && /^\/api\/screenshots\/[a-f0-9-]{36}\/(light|dark)-(390|1440)$/.test(path)) {
        const [, , , id, captureId] = path.split('/');
        const target = await getTarget(id!);
        if (!target?.captures.some(capture => capture.id === captureId)) {
          send(404, { error: 'Screenshot not found.' });
          return;
        }
        const bytes = store ? await store.download(`${id}.${captureId}.png`) : await screenshotBytes(target, captureId!, directory);
        if (!bytes) { send(404, { error: 'Screenshot not found.' }); return; }
        response.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'no-store' });
        response.end(bytes);
        return;
      }
      if (request.method !== 'POST' || request.headers.origin !== origin || request.headers['content-type'] !== 'application/json') { send(403, { error: 'This action must come from the application.' }); return; }
      if (store) {
        if (writing || active) { send(409, { error: 'Another task is running. Try again when it finishes.' }); return; }
        writing = true;
        holdsWrite = true;
      }
      let length = 0; const chunks: Buffer[] = [];
      for await (const chunk of request) { length += chunk.length; if (length > 12_000_000) throw new Error('Request is too large. Upload one file at a time, under 8 MB.'); chunks.push(chunk); }
      const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
      if (path === '/api/import') {
        if ((store ? await store.count('source') : sources.size) >= 30) throw new Error('This workspace has reached its 30-source limit.');
        let source: IntakeSource;
        if (input.type === 'link' && typeof input.value === 'string') source = await readLink(input.value, store ? '' : undefined);
        else if (input.type === 'text' && typeof input.value === 'string' && input.value.trim()) source = sourceFromText(typeof input.name === 'string' ? input.name : 'Pasted guidelines', input.value);
        else if (input.type === 'file' && typeof input.name === 'string' && typeof input.data === 'string' && /^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) source = await readAsset(input.name, Buffer.from(input.data, 'base64'), typeof input.mediaType === 'string' ? input.mediaType : 'application/octet-stream');
        else throw new Error('Add a link, a file or some guidelines first.');
        const { original, ...publicSource } = source;
        if (store) {
          const name = `${source.id}.source`;
          try {
            await store.upload(name, Buffer.from(original, source.originalEncoding), 'application/octet-stream');
            await store.put('source', publicSource);
          } catch (error) {
            await discardUncommittedFiles(store, 'source', source.id, [name]);
            throw error;
          }
        } else sources.set(source.id, source);
        send(200, publicSource);
        return;
      }
      if(path==='/api/interpret') {
        if (store) { send(403, { error: 'AI assistance is unavailable in this preview.' }); return; }
        const source=sources.get(String(input.sourceId));if(!source)throw new Error('Add this source again before interpreting it.');
        if(!ai.configured)throw new Error('OpenRouter is not connected. Add the key locally and restart the app.');
        send(202,await startJob(async()=>{const result=await ai.extract(source);return {sourceId:source.id,...result};},'Interpreting the documented text sizes and colors…'));return;
      }
      if(path==='/api/inspect') {
        const system = await getSystem(String(input.systemId));
        if (!system) throw new Error('Save your reviewed design system first.');
        if (typeof input.url !== 'string') throw new Error('Add a public website URL.');
        const themes = input.themes;
        if (!Array.isArray(themes) || !themes.length || themes.length > 2 || themes.some(t => !['light', 'dark'].includes(String(t))) || new Set(themes).size !== themes.length) throw new Error('Choose light, dark or both browser preferences.');
        if ((store ? await store.count('target') : targets.size) >= 5) throw new Error('This workspace has reached its five-capture limit.');
        const url = input.url;
        send(202, await startJob(async () => {
          const captureRoot = store ? await mkdtemp(join(tmpdir(), 'auditor-capture-')) : directory;
          try {
            const target = await (services.inspect ?? inspectWebsite)(url, captureRoot, themes as ('light' | 'dark')[], undefined, system.rules.map(r => r.size).filter(Boolean));
            if (store) {
              const files = [];
              try {
                for (const capture of target.captures) {
                  const name = `${target.id}.${capture.id}.png`;
                  files.push(name);
                  await store.upload(name, await screenshotBytes(target, capture.id, captureRoot), 'image/png');
                }
                await store.put('target', target);
              } catch (error) {
                await discardUncommittedFiles(store, 'target', target.id, files);
                throw error;
              }
            } else targets.set(target.id, target);
            return { id: target.id, url: target.url, candidates: target.candidates, mappings: matchPageText(system.rules, target.candidates), captures: target.captures.map(c => ({ id: c.id, width: c.width, theme: c.theme, issues: c.issues, truncated: c.truncated })) };
          } finally {
            if (store) await rm(captureRoot, { recursive: true, force: true }).catch(() => {});
          }
        }, 'Capturing the selected page at mobile and desktop widths…', store));
        return;
      }
      if(path==='/api/map') {
        if (store) { send(403, { error: 'AI assistance is unavailable in this preview.' }); return; }
        const system=systems.get(String(input.systemId)),target=targets.get(String(input.targetId));if(!system||!target)throw new Error('Save your rules and capture a target first.');
        if(!ai.configured)throw new Error('OpenRouter is not connected. Select mappings manually or configure your local key.');
        send(202,await startJob(()=>ai.map(system.rules,target.candidates),'Suggesting which rules apply to the captured text…'));return;
      }
      if(path==='/api/audit') {
        const [system, target] = await Promise.all([getSystem(String(input.systemId)), getTarget(String(input.targetId))]);
        if (!system || !target) throw new Error('Load a design system and capture a page first.');
        const automatic = input.automatic === true;
        if (!automatic && (!Array.isArray(input.mappings) || input.mappings.length > 200 || input.reviewed !== true)) throw new Error('Review the selected page text before checking it.');
        const mappings = automatic ? matchPageText(system.rules, target.candidates) : input.mappings as Mapping[];
        const report = compareWebsite(target, system.rules, mappings);
        if (!report.checked && !report.unchecked.length && !automatic) throw new Error('No selected text applies in these captures. Check the selected text, themes and widths.');
        if (automatic) {
          report.limitations[0] = 'Only text with a clear match to a confirmed design system rule was checked.';
          if (!mappings.some(mapping => mapping.elementIds.length)) report.unchecked.push('No text could be confidently matched to the saved design system rules.');
        }
        if (store) {
          if (await store.count('report') >= 30) throw new Error('This workspace has reached its 30-report limit.');
          await store.put('report', { id: report.id, url: report.url, report, rules: system.rules, mappings });
        } else await saveWebReport(report, target, system.rules, mappings, directory);
        send(200, report);
        return;
      }
      if (path === '/api/save') {
        if (input.reviewed !== true) throw new Error('Review the rules before saving.');
        if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 120) throw new Error('Give your design system a name, up to 120 characters.');
        if (!Array.isArray(input.rules) || !input.rules.length || input.rules.length > 200) throw new Error('Review at least one rule before saving (maximum 200).');
        const reviewed: IntakeRule[] = input.rules.map((value: unknown) => {
          if (!value || typeof value !== 'object') throw new Error('Invalid rule.');
          const rule = value as Record<string, unknown>;
          if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.length > 160 || typeof rule.size !== 'string' || typeof rule.color !== 'string' || (rule.size && !validSize(rule.size)) || (rule.color && !validColor(rule.color)) || (!rule.size && !rule.color) || !['all', 'light', 'dark'].includes(String(rule.theme))) throw new Error('Each rule needs a name and a valid text size or color. Check its source and theme.');
          const result: IntakeRule = { id: randomUUID(), name: rule.name.trim(), size: rule.size, color: rule.color, theme: rule.theme as IntakeRule['theme'], sourceId: String(rule.sourceId), evidence: typeof rule.evidence === 'string' ? rule.evidence.slice(0, 600) : 'Owner-entered rule' };
          for(const key of ['aboveWidth','maxWidth'] as const) if(rule[key]!==undefined){if(typeof rule[key]!=='number'||!Number.isInteger(rule[key])||rule[key]<0||rule[key]>10000)throw new Error('Width conditions must be whole pixels between 0 and 10,000.');result[key]=rule[key];}
          if(result.aboveWidth!==undefined&&result.maxWidth!==undefined&&result.aboveWidth>=result.maxWidth)throw new Error('The lower width must be below the upper width.');
          if(typeof rule.conditionEvidence==='string')result.conditionEvidence=rule.conditionEvidence.slice(0,600);return result;
        });
        for(let i=0;i<reviewed.length;i++)for(const other of reviewed.slice(i+1)) {
          const rule=reviewed[i]!;const overlaps=rule.name.toLowerCase()===other.name.toLowerCase()&&(rule.theme===other.theme||rule.theme==='all'||other.theme==='all')&&Math.max(rule.aboveWidth??-1,other.aboveWidth??-1)<Math.min(rule.maxWidth??Infinity,other.maxWidth??Infinity);
          if(overlaps&&((rule.size&&other.size&&rule.size!==other.size)||(rule.color&&other.color&&rule.color!==other.color)))throw new Error(`Conflicting size or color for ${rule.name}. Separate its theme/width usage or remove the duplicate.`);
        }
        const attached = input.sourceIds ?? [];
        if (!Array.isArray(attached) || attached.length > 30 || attached.some(id => typeof id !== 'string')) {
          throw new Error('One of the attached sources is invalid.');
        }
        const sourceIds = [...new Set([...reviewed.map(rule => rule.sourceId), ...attached as string[]])].filter(id => id !== 'manual');
        if (sourceIds.length > 30) throw new Error('A saved system can include up to 30 sources.');
        const privateSources = [];
        for (const sourceId of sourceIds) {
          const source = await getSource(sourceId);
          if (!source) throw new Error('One of the attached sources is unavailable in this workspace.');
          privateSources.push(source);
        }
        const id = randomUUID();
        const version: SavedSystem = { schemaVersion: 'design-system-1', id, version: 1, name: input.name.trim(), createdAt: new Date().toISOString(), auditProperties: ['font-size', 'color'], rules: reviewed, sourceIds };
        const { sourceIds: _sourceIds, ...publicVersion } = version;
        if (store) {
          if (await store.count('system') >= 30) throw new Error('This workspace has reached its 30-version limit.');
          await store.put('system', version);
          send(200, { ...publicVersion, sourceCount: privateSources.length });
        } else {
          const savedPath = `reports/design-systems/${id}/system.json`;
          const folder = await createCaptureDirectory(`reports/design-systems/${id}`, directory);
          await writeFile(join(folder, 'system.json'), JSON.stringify({ ...publicVersion, sources: privateSources }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
          systems.set(id, version);
          send(200, { ...publicVersion, sourceCount: privateSources.length, savedPath });
        }
        return;
      }
      send(404, { error: 'Unknown action.' });
    } catch (error) {
      send(error instanceof SupabaseUnavailable ? 503 : 400, { error: error instanceof Error ? error.message : 'This source could not be read.' });
    } finally {
      if (holdsWrite) writing = false;
    }
  };
}

export function intakeServer(directory = process.cwd(), services: IntakeServices = {}) {
  return createServer(intakeHandler(directory, services));
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.INTAKE_PORT ?? '4341');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid INTAKE_PORT.');
  intakeServer().listen(port, '127.0.0.1', () => process.stdout.write(`Design-system intake: http://127.0.0.1:${port}/\n`));
}
