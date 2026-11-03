import type { IntakeRule } from './intake.js';
import type { Candidate, Mapping } from './openrouter.js';
import type { WebReport } from './web-audit.js';
const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
let systemId='',rules:IntakeRule[]=[],targetId='',candidates:Candidate[]=[],mappings:Mapping[]=[],busy=false,generation=0;
const message=(text:string,error=false)=>{get('target-status').textContent=text;get('target-status').classList.toggle('error',error);};
async function post(path:string,data:unknown){const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw new Error(value.error??'The task failed.');return value;}
async function job(path:string,data:unknown){let item=await post(path,data);while(item.state==='running'){message(item.message);await new Promise(resolve=>setTimeout(resolve,800));const r=await fetch(`/api/jobs/${item.id}`);item=await r.json();if(!r.ok)throw new Error('Task status is unavailable. Try the task again.');}if(item.state!=='done')throw new Error(item.message);return item.result;}
function controls(){get<HTMLButtonElement>('inspect-target').disabled=busy;get<HTMLButtonElement>('suggest-mappings').disabled=busy||!targetId;get<HTMLButtonElement>('run-audit').disabled=busy||!targetId||!get<HTMLInputElement>('mappings-reviewed').checked||!mappings.some(m=>m.elementIds.length>0);}
async function working(action:()=>Promise<void>){if(busy)return;busy=true;controls();try{await action();}catch(error){message(error instanceof Error?error.message:'This task failed.',true);}finally{busy=false;controls();}}
export function disableTarget(){generation++;get('target-panel').hidden=true;get('web-results').hidden=true;}
export function enableTarget(id:string,reviewedRules:IntakeRule[]){generation++;systemId=id;rules=reviewedRules;targetId='';mappings=[];candidates=[];get('target-panel').hidden=false;get('mapping-panel').hidden=true;get('web-results').hidden=true;message('Add the public page you want to check against these saved rules.');controls();}
function targetChanged(){generation++;targetId='';mappings=[];candidates=[];get('mapping-panel').hidden=true;get('web-results').hidden=true;get<HTMLInputElement>('mappings-reviewed').checked=false;message('Page settings changed. Capture the page again before selecting its text.');controls();}
get('target-url').oninput=targetChanged;get('target-theme').onchange=targetChanged;
function mappingChanged(){get<HTMLInputElement>('mappings-reviewed').checked=false;get('web-results').hidden=true;controls();}
function renderMappings(){
  const list=get('mapping-list');list.replaceChildren();
  for(const rule of rules){const mapping=mappings.find(m=>m.ruleId===rule.id)??{ruleId:rule.id,elementIds:[]};if(!mappings.includes(mapping))mappings.push(mapping);
    const details=el('details','','mapping-rule');const summary=el('summary');const label=el('span',rule.name);const count=el('span',`${mapping.elementIds.length} selected`,'mapping-count');summary.append(label,count);details.append(summary,el('p',[rule.size,rule.color,rule.theme!=='all'?rule.theme:'',rule.aboveWidth!==undefined?`Above ${rule.aboveWidth}px`:'',rule.maxWidth!==undefined?`Up to ${rule.maxWidth}px`:''].filter(Boolean).join(' · '),'hint'));
    let built=false;details.ontoggle=()=>{if(!details.open||built)return;built=true;const filter=el('input');filter.placeholder='Find text on the page';filter.setAttribute('aria-label',`Find elements for ${rule.name}`);const choices=el('div','','mapping-choices');
      for(const candidate of candidates){const row=el('label','','check mapping-choice');const check=el('input');check.type='checkbox';check.checked=mapping.elementIds.includes(candidate.id);check.onchange=()=>{mapping.elementIds=check.checked?[...mapping.elementIds,candidate.id]:mapping.elementIds.filter(id=>id!==candidate.id);count.textContent=`${mapping.elementIds.length} selected`;mappingChanged();};row.dataset.search=`${candidate.tag} ${candidate.text} ${candidate.classes}`.toLowerCase();row.append(check,el('span',`${candidate.text} (${candidate.tag})`));choices.append(row);}
      filter.oninput=()=>{for(const row of choices.children as HTMLCollectionOf<HTMLElement>)row.hidden=!row.dataset.search!.includes(filter.value.toLowerCase());};details.append(filter,choices);
    };list.append(details);
  }
  get('mapping-panel').hidden=false;mappingChanged();
}
get<HTMLFormElement>('target-form').onsubmit=event=>{event.preventDefault();void working(async()=>{
  get('web-results').hidden=true;get('mapping-panel').hidden=true;
  const selected=get<HTMLSelectElement>('target-theme').value;const themes=selected==='both'?['light','dark']:[selected];
  const version=generation;const result=await job('/api/inspect',{systemId,url:get<HTMLInputElement>('target-url').value.trim(),themes});if(version!==generation)return;targetId=result.id;candidates=result.candidates;mappings=[];
  renderMappings();const issue=result.captures.some((c:{issues:string[];truncated:boolean})=>c.issues.length||c.truncated);
  message(issue?'Page captured with coverage limits. Affected captures stay unchecked; review the capture details in the result.':'Page captured. Suggest where the rules apply, or select the text yourself.');
});};
get('suggest-mappings').onclick=()=>void working(async()=>{const version=generation;const result=await job('/api/map',{systemId,targetId});if(version!==generation)return;mappings=result.mappings;renderMappings();message(`Suggestions ready. Review the selected text for each rule before auditing. ${usage(result.receipt)}`);});
get('mappings-reviewed').onchange=controls;
get('run-audit').onclick=()=>void working(async()=>{const version=generation;const report:WebReport=await post('/api/audit',{systemId,targetId,mappings,reviewed:true});if(version!==generation)return;renderReport(report);message('Audit saved locally. Only errors appear in the report.');});
export function usage(receipt:{chargedUSD:number|null;cached?:boolean}){return receipt.cached?'Reused cached interpretation.':receipt.chargedUSD!==null?`AI request: $${receipt.chargedUSD.toFixed(5)}.`:'AI usage recorded; provider cost unavailable.';}
function renderReport(report:WebReport){
  const root=get('web-results');root.replaceChildren();root.append(el('h2',!report.checked?'No selected text could be checked':report.differences.length?`${report.differences.length} design ${report.differences.length===1?'error':'errors'}`:'No errors in the selected checks'),el('p',report.url,'report-url'),el('p','Only the rules and page text you selected were checked. This result is partial coverage.','hint'));
  if(!report.checked)root.append(el('p','Capture the page again after checking its access and loading issues, or select text that can be measured. No conformance result is available.','status error'));
  if(report.unchecked.length||report.unmappedRules.length){const details=el('details','','coverage');details.open=!report.checked;details.append(el('summary','What was not checked'));for(const line of report.unchecked)details.append(el('p',line));if(report.unmappedRules.length)details.append(el('p',`Rules without selected text: ${report.unmappedRules.join(', ')}`));root.append(details);}
  if(report.differences.length){const workspace=el('div','','error-workspace');const list=el('div','','error-index');list.setAttribute('aria-label','Design errors');const detail=el('section','','error-detail');let selected=0,location=0;
    const show=()=>{detail.replaceChildren();const difference=report.differences[selected]!;const affected=difference.locations[location]!;const capture=report.captures.find(c=>c.id===affected.captureId)!;
      for(const [i,b] of [...list.children].entries()){b.classList.toggle('selected',i===selected);b.setAttribute('aria-pressed',String(i===selected));}
      detail.append(el('h3',`${difference.name}: ${difference.property==='font-size'?'text size':'text color'}`));const values=el('div','','error-values');for(const [label,value] of [['Design system',difference.expected],['On this page',difference.actual]]){const col=el('div');col.append(el('p',label!,'hint'),el('strong',value!));values.append(col);}detail.append(values,el('p',affected.text,'affected-text'));
      const toolbar=el('div','','actions');toolbar.append(el('span',`${capture.width}px · ${capture.theme} preference · Location ${location+1} of ${difference.locations.length}`,'hint'));const next=el('button','Next affected location');next.type='button';next.disabled=difference.locations.length<2;next.onclick=()=>{location=(location+1)%difference.locations.length;show();detail.querySelector<HTMLButtonElement>('button')?.focus();};toolbar.append(next);detail.append(toolbar);
      const viewport=el('div','','evidence-viewport');const frame=el('div','','evidence-frame');const image=el('img');image.alt=`${difference.name} on the captured page at ${capture.width}px`;image.src=`/api/screenshots/${targetId}/${capture.id}`;image.style.width=`${capture.width}px`;frame.style.width=`${capture.width}px`;const highlight=el('div','','evidence-highlight');highlight.setAttribute('aria-hidden','true');Object.assign(highlight.style,{left:`${affected.bounds.x}px`,top:`${affected.bounds.y}px`,width:`${affected.bounds.width}px`,height:`${affected.bounds.height}px`});frame.append(image,highlight);viewport.append(frame);detail.append(viewport);image.onload=()=>{viewport.scrollTop=Math.max(0,affected.bounds.y-80);viewport.scrollLeft=Math.max(0,affected.bounds.x-40);};
      const provenance=el('details','','provenance');const rule=rules.find(r=>r.id===difference.ruleId);provenance.append(el('summary','Rule source and capture details'),el('p',rule?.evidence??''),el('p',rule?.conditionEvidence??''),el('p',report.limitations.join(' ')));detail.append(provenance);
    };
    report.differences.forEach((d,i)=>{const button=el('button',`${d.name}: ${d.property==='font-size'?'text size':'text color'}`);button.type='button';button.onclick=()=>{selected=i;location=0;show();};list.append(button);});workspace.append(list,detail);root.append(workspace);show();
  }
  const download=el('button','Download audit evidence');download.type='button';download.onclick=()=>{const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download='audit-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};root.append(download);root.hidden=false;root.scrollIntoView({behavior:'instant',block:'start'});
}
