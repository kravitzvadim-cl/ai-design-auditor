import { enableTarget, disableTarget, usage } from './web-audit-client.js';
import type { IntakeRule, IntakeSource } from './intake.js';
const get = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const sourceList: Omit<IntakeSource, 'original'>[] = []; let rules: IntakeRule[] = []; let busy = false; let aiAvailable = false;
const element = <K extends keyof HTMLElementTagNameMap>(tag: K, text = '', className = '') => { const node = document.createElement(tag); node.textContent = text; node.className = className; return node; };
const status = (id: string, message: string, error = false) => { get(id).textContent = message; get(id).classList.toggle('error', error); };
async function api(path: string, data: unknown): Promise<Record<string, unknown>> {
  const result = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); const body = await result.json(); if (!result.ok) throw new Error(body.error ?? 'This action could not be completed.'); return body;
}
function changed() { disableTarget(); get<HTMLInputElement>('reviewed').checked = false; get('saved').hidden = true; updateSave(); }
function updateSave() { get<HTMLButtonElement>('save').disabled = busy || !rules.length || !get<HTMLInputElement>('reviewed').checked || !get<HTMLInputElement>('system-name').value.trim(); get('rule-count').textContent = rules.length ? `${rules.length} text ${rules.length === 1 ? 'rule' : 'rules'}` : 'No rules yet'; }
function renderSources() {
  const list = get('sources'); list.replaceChildren();
  for (const source of sourceList) {
    const card = element('div', '', 'source'); const head = element('div', '', 'source-head'); const name = element('div', source.name, 'source-name');
    const remove = element('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove source ${source.name}`);
    remove.onclick = () => { sourceList.splice(sourceList.indexOf(source), 1); rules = rules.filter(r => r.sourceId !== source.id); renderSources(); renderRules(); changed(); };
    const interpret = element('button', 'Interpret with AI'); interpret.type='button';interpret.disabled=!aiAvailable||busy||!source.text.trim();interpret.setAttribute('aria-label',`Interpret ${source.name} with AI`);
    interpret.onclick=()=>void importing(async()=>{
      const start=await api('/api/interpret',{sourceId:source.id});let item=start;
      while(item.state==='running'){status('import-status','Interpreting explicit text rules with Gemini Flash Lite…');await new Promise(resolve=>setTimeout(resolve,800));const response=await fetch(`/api/jobs/${item.id}`);item=await response.json();if(!response.ok)throw new Error('Task status is unavailable.');}
      if(item.state!=='done')throw new Error(String(item.message));const result=item.result as {rules:IntakeRule[];notes:string[];receipt:{chargedUSD:number|null;cached:boolean}};
      rules=rules.filter(r=>r.sourceId!==source.id);rules.push(...result.rules);source.rules=result.rules;source.message=[`${result.rules.length} AI suggestions. Review values, sources and conditions.`,...result.notes,usage(result.receipt)].join(' ');renderSources();renderRules();changed();
    });
    const actions=element('div','','source-actions');actions.append(interpret,remove);head.append(name, actions); card.append(head, element('p', `${source.kind} · ${source.state === 'connection-required' ? 'Connection needed' : source.state === 'needs-review' ? 'Manual review needed' : 'Ready to review'}`), element('p', source.message));
    if (source.text) { const details = element('details'); details.append(element('summary', 'Read extracted source text'), element('pre', source.text.slice(0, 12000), 'excerpt')); card.append(details); }
    list.append(card);
  }
}
function field(label: string, value: string, onInput: (value: string) => void, id: string): HTMLElement {
  const box = element('div'); const title = element('label', label); title.htmlFor = id; const input = element('input'); input.id = id; input.value = value; input.oninput = () => { onInput(input.value); changed(); }; box.append(title, input); return box;
}
function renderRules() {
  const list = get('rule-list'); list.replaceChildren();
  if (!rules.length) list.append(element('p', 'Your imported rules will appear here. You can also add a rule yourself, even if a source needs access or a different export.', 'empty'));
  for (const rule of rules) {
    const row = element('div', '', 'rule'); const head = element('div', '', 'rule-head');
    const name = element('input'); name.value = rule.name; name.maxLength = 160; name.setAttribute('aria-label', 'Text style name'); name.oninput = () => { rule.name = name.value; changed(); };
    const remove = element('button', 'Remove'); remove.type = 'button'; remove.setAttribute('aria-label', `Remove rule ${rule.name || 'unnamed'}`); remove.onclick = () => { rules = rules.filter(r => r.id !== rule.id); renderRules(); changed(); }; head.append(name, remove);
    const fields = element('div', '', 'rule-fields');
    const size = field('Text size', rule.size, value => rule.size = value.trim(), `size-${rule.id}`); (size.querySelector('input')!).placeholder = '16px';
    const color = field('Text color', rule.color, value => { rule.color = value.trim(); swatch.style.backgroundColor = ''; if (CSS.supports('color', rule.color)) swatch.style.backgroundColor = rule.color; }, `color-${rule.id}`);
    const swatch = element('span', '', 'swatch'); swatch.setAttribute('aria-hidden', 'true'); if (CSS.supports('color', rule.color)) swatch.style.backgroundColor = rule.color; const colorInput = color.querySelector('input')!; colorInput.placeholder = '#183b36'; const pair = element('div', '', 'color-field'); pair.append(swatch, colorInput); color.append(pair);
    const mode = element('div'); const label = element('label', 'Applies to'); label.htmlFor = `mode-${rule.id}`; const select = element('select'); select.id = label.htmlFor;
    for (const [value, text] of [['all', 'Both themes'], ['light', 'Light'], ['dark', 'Dark']]) { const option = element('option', text); option.value = value!; select.append(option); } select.value = rule.theme; select.onchange = () => { rule.theme = select.value as IntakeRule['theme']; changed(); }; mode.append(label, select);
    fields.append(size, color, mode); const provenance = element('details', '', 'provenance'); provenance.append(element('summary', rule.sourceId === 'manual' ? 'Source and width conditions' : 'Rule source and width conditions'), element('p', rule.evidence),element('p',rule.conditionEvidence??''));
    const conditions=element('div','','rule-fields');for(const [key,label] of [['aboveWidth','Above width (px)'],['maxWidth','Up to width (px)']] as const){const condition=field(label,rule[key]===undefined?'':String(rule[key]),value=>{if(value.trim()==='')delete rule[key];else rule[key]=Number(value);},`${key}-${rule.id}`);const input=condition.querySelector('input')!;input.type='number';input.min='0';input.max='10000';conditions.append(condition);}provenance.append(conditions);
    row.append(head, fields, provenance); list.append(row);
  }
  updateSave();
}
async function add(data: unknown) {
  const result = await api('/api/import', data) as unknown as Omit<IntakeSource, 'original'>;
  sourceList.push(result); rules.push(...result.rules); renderSources(); renderRules(); changed();
  return result;
}
async function importing(action: () => Promise<void>) {
  if (busy) return; busy = true; get<HTMLButtonElement>('add-source').disabled = true; get<HTMLButtonElement>('choose-files').disabled = true; updateSave(); status('import-status', 'Reading your source locally…');
  try { await action(); status('import-status', 'Source added. Review the suggestions or enter any missing rules.'); } catch (error) { status('import-status', error instanceof Error ? error.message : 'Source could not be read.', true); }
  finally { busy = false; get<HTMLButtonElement>('add-source').disabled = false; get<HTMLButtonElement>('choose-files').disabled = false; renderSources(); updateSave(); }
}
get<HTMLFormElement>('import-form').onsubmit = event => { event.preventDefault(); const value = get<HTMLTextAreaElement>('source-input').value.trim(); if (!value) return; void importing(async () => { await add({ type: /^https?:\/\/\S+$/i.test(value) ? 'link' : 'text', value }); get<HTMLTextAreaElement>('source-input').value = ''; }); };
async function files(list: FileList | File[]) {
  await importing(async () => {
    const failures: string[] = [];
    for (const file of Array.from(list)) {
      try {
        if (file.size > 8_000_000 || !file.size) throw new Error('File must be nonempty and smaller than 8 MB.');
        const buffer = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (let i = 0; i < buffer.length; i += 8192) binary += String.fromCharCode(...buffer.subarray(i, i + 8192));
        await add({ type: 'file', name: file.name, mediaType: file.type, data: btoa(binary) });
      } catch (error) { failures.push(`${file.name}: ${error instanceof Error ? error.message : 'Could not read file'}`); }
    }
    if (failures.length) throw new Error(failures.join(' '));
  });
}
get('choose-files').onclick = () => get<HTMLInputElement>('files').click(); get<HTMLInputElement>('files').onchange = event => { const input = event.target as HTMLInputElement; if (input.files) void files(input.files); input.value = ''; };
const drop = get('drop'); drop.ondragover = event => { event.preventDefault(); drop.classList.add('drag'); }; drop.ondragleave = () => drop.classList.remove('drag'); drop.ondrop = event => { event.preventDefault(); drop.classList.remove('drag'); if (event.dataTransfer?.files) void files(event.dataTransfer.files); };
get('add-rule').onclick = () => { rules.push({ id: crypto.randomUUID(), name: '', size: '', color: '', theme: 'all', sourceId: 'manual', evidence: 'Owner-entered rule' }); renderRules(); changed(); get('rule-list').lastElementChild?.querySelector('input')?.focus(); };
get('reviewed').onchange = updateSave; get('system-name').oninput = () => { get('saved').hidden = true; updateSave(); };
get('save').onclick = async () => {
  if (get<HTMLButtonElement>('save').disabled) return; busy = true; updateSave(); status('save-status', 'Saving locally…');
  try {
    const saved = await api('/api/save', { name: get<HTMLInputElement>('system-name').value.trim(), rules, sourceIds: sourceList.map(source => source.id), reviewed: true });
    const panel = get('saved'); panel.replaceChildren(element('h2', 'Design system saved'), element('p', `${saved.name} · Version ${saved.version} · ${Array.isArray(saved.rules) ? saved.rules.length : 0} reviewed text ${Array.isArray(saved.rules)&&saved.rules.length===1?'rule':'rules'}`), element('p', 'Your rules and source snapshots are saved locally. Choose a page below to check against them.'));
    const path = element('code', String(saved.savedPath)); panel.append(path); const download = element('button', 'Download reviewed rules'); download.style.marginTop = '16px'; download.onclick = () => { const blob = new Blob([JSON.stringify(saved, null, 2)], { type: 'application/json' }); const url = URL.createObjectURL(blob); const a = element('a'); a.href = url; a.download = 'design-system.json'; a.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); }; panel.append(element('br'), download); panel.hidden = false; enableTarget(String(saved.id),saved.rules as IntakeRule[]); panel.scrollIntoView({ behavior: 'instant', block: 'start' }); status('save-status', 'Saved. Your original sources have not been changed.');
  } catch (error) { status('save-status', error instanceof Error ? error.message : 'Saving failed.', true); }
  finally { busy = false; updateSave(); }
};
renderRules();
void fetch('/api/status').then(r => r.json()).then(info => { aiAvailable=!!info.ai;get('ai-connection').textContent=info.ai?'Gemini 2.5 Flash Lite connected through OpenRouter. Interpret with AI sends this source’s extracted text to the provider. Session budget: $0.25.':'AI is not connected. Set OPENROUTER_API_KEY in .env and restart the app. Manual rules and capture still work.';renderSources();get('connections').textContent = info.figma ? 'Figma connection configured. Imports use your access permissions.' : 'Figma links can be added. Reading Figma content needs a local connection or an exported file.'; }).catch(() => { get('connections').textContent = 'Connection status is unavailable. Reload to try again.'; });
