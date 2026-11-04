import type { IntakeRule } from './intake.js';
import type { Candidate, Mapping } from './openrouter.js';
import type { WebReport } from './web-audit.js';
const projectPath = /^\/projects\/[a-f0-9-]{36}$/.test(location.pathname) ? location.pathname : '';
export const apiPath = (path: string) => projectPath + path;
export const isPrivateWorkspace = Boolean(projectPath);
const get=<T extends HTMLElement=HTMLElement>(id:string)=>document.getElementById(id) as T;
const el=<K extends keyof HTMLElementTagNameMap>(tag:K,text='',className='')=>{const n=document.createElement(tag);n.textContent=text;n.className=className;return n;};
let systemId='',rules:IntakeRule[]=[],targetId='',candidates:Candidate[]=[],mappings:Mapping[]=[],busy=false,generation=0;
const message=(text:string,error=false)=>{
  const status=get('target-status');
  if(status.textContent!==text)status.textContent=text;
  status.classList.toggle('error',error);
};
function updateNavigation(current:'system'|'target'|'report'){
  const links=[['system','source-title'],['target','target-panel'],['report','web-results']] as const;
  for(const [step,target] of links){
    const link=get('audit-nav-'+step);
    if(step==='system'||!get(target).hidden){
      link.setAttribute('href','#'+target);link.removeAttribute('aria-disabled');
    }else{
      link.removeAttribute('href');link.setAttribute('aria-disabled','true');
    }
    if(step===current)link.setAttribute('aria-current','step');
    else link.removeAttribute('aria-current');
  }
}
for(const step of ['system','target','report'] as const)get('audit-nav-'+step).onclick=()=>{
  if(get('audit-nav-'+step).hasAttribute('href'))updateNavigation(step);
};
async function post(path:string,data:unknown){const r=await fetch(apiPath(path),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await r.json();if(!r.ok)throw new Error(value.error??'The task failed.');return value;}
async function job(path:string,data:unknown){let item=await post(path,data);while(item.state==='running'){message(item.message);await new Promise(resolve=>setTimeout(resolve,800));const r=await fetch(apiPath(`/api/jobs/${item.id}`));item=await r.json();if(!r.ok)throw new Error('Task status is unavailable. Try the task again.');}if(item.state!=='done')throw new Error(item.message);return item.result;}
function controls(){get<HTMLButtonElement>('inspect-target').disabled=busy;get<HTMLButtonElement>('suggest-mappings').disabled=busy||!targetId;get<HTMLButtonElement>('run-audit').disabled=busy||!targetId||!mappings.some(m=>m.elementIds.length>0);}
async function working(action:()=>Promise<void>, initialStage?:string){
  if(busy)return;
  busy=true;
  const progress=get('audit-progress');
  if(initialStage){progress.hidden=false;message(initialStage);}
  controls();
  try{await action();}
  catch(error){message(error instanceof Error?error.message:'This task failed.',true);}
  finally{progress.hidden=true;busy=false;controls();}
}
export function disableTarget(){generation++;get('target-panel').hidden=true;get('web-results').hidden=true;updateNavigation('system');}
export function enableTarget(id:string,reviewedRules:IntakeRule[]){generation++;systemId=id;rules=reviewedRules;targetId='';mappings=[];candidates=[];get('target-panel').hidden=false;get('mapping-panel').hidden=true;get('web-results').hidden=true;message('Add the public page you want to check against these saved rules.');updateNavigation('target');controls();}
function targetChanged(){generation++;targetId='';mappings=[];candidates=[];get('mapping-panel').hidden=true;get('web-results').hidden=true;message('Ready to check the page with these settings.');updateNavigation('target');controls();}
get('target-url').oninput=targetChanged;get('target-theme').onchange=targetChanged;
function mappingChanged(){controls();}
function renderMappings(){
  const list=get('mapping-list');list.replaceChildren();
  for(const rule of rules){const mapping=mappings.find(m=>m.ruleId===rule.id)??{ruleId:rule.id,elementIds:[]};if(!mappings.includes(mapping))mappings.push(mapping);
    const details=el('details','','mapping-rule');const summary=el('summary');const label=el('span',rule.name);const count=el('span',`${mapping.elementIds.length} selected`,'mapping-count');summary.append(label,count);details.append(summary,el('p',[rule.size,rule.color,rule.theme!=='all'?rule.theme:'',rule.aboveWidth!==undefined?`Above ${rule.aboveWidth}px`:'',rule.maxWidth!==undefined?`Up to ${rule.maxWidth}px`:''].filter(Boolean).join(' · '),'hint'));
    let built=false;details.ontoggle=()=>{if(!details.open||built)return;built=true;const filter=el('input');filter.placeholder='Find text on the page';filter.setAttribute('aria-label',`Find elements for ${rule.name}`);const choices=el('div','','mapping-choices');
      for(const candidate of candidates){const row=el('label','','check mapping-choice');const check=el('input');check.type='checkbox';check.checked=mapping.elementIds.includes(candidate.id);check.onchange=()=>{mapping.elementIds=check.checked?[...mapping.elementIds,candidate.id]:mapping.elementIds.filter(id=>id!==candidate.id);count.textContent=`${mapping.elementIds.length} selected`;mappingChanged();};row.dataset.search=`${candidate.tag} ${candidate.text} ${candidate.classes}`.toLowerCase();row.append(check,el('span',`${candidate.text} (${candidate.tag})`));choices.append(row);}
      filter.oninput=()=>{for(const row of choices.children as HTMLCollectionOf<HTMLElement>)row.hidden=!row.dataset.search!.includes(filter.value.toLowerCase());};details.append(filter,choices);
    };list.append(details);
  }
  const panel=get<HTMLDetailsElement>('mapping-panel');panel.open=false;panel.hidden=false;mappingChanged();
}
get<HTMLFormElement>('target-form').onsubmit=event=>{event.preventDefault();void working(async()=>{
  get('web-results').hidden=true;get('mapping-panel').hidden=true;updateNavigation('target');
  const selected=get<HTMLSelectElement>('target-theme').value;const themes=selected==='both'?['light','dark']:[selected];
  const version=generation;
  const result=await job('/api/inspect',{systemId,url:get<HTMLInputElement>('target-url').value.trim(),themes});
  if(version!==generation)return;
  targetId=result.id;candidates=result.candidates;mappings=result.mappings;
  renderMappings();
  await showAudit(version, true);
},'Starting the audit…');};
get('suggest-mappings').onclick=()=>void working(async()=>{
  const version=generation;const result=await job('/api/map',{systemId,targetId});
  if(version!==generation)return;
  mappings=result.mappings;renderMappings();get<HTMLDetailsElement>('mapping-panel').open=true;
  message('Suggestions ready. Select Check selected text again to apply them.');
});
if (!isPrivateWorkspace) void fetch(apiPath('/api/status')).then(r=>r.json()).then(info=>{
  get('suggest-mappings').hidden=!info.ai;
}).catch(()=>{});
async function showAudit(version:number,automatic:boolean){
  message('Checking text against your design system…');
  const report:WebReport=await post('/api/audit',{systemId,targetId,automatic,mappings,reviewed:!automatic});
  if(version!==generation)return;
  renderReport(report);
  message(report.checked ? 'Audit complete.' : 'No text could be checked. See the coverage details in the report.');
  if(isPrivateWorkspace)document.dispatchEvent(new Event('library-updated'));
}
get('run-audit').onclick=()=>void working(()=>showAudit(generation,false),'Checking selected text…');
export function usage(receipt:{chargedUSD:number|null;cached?:boolean}){return receipt.cached?'Reused cached interpretation.':receipt.chargedUSD!==null?`AI request: $${receipt.chargedUSD.toFixed(5)}.`:'AI usage recorded; provider cost unavailable.';}
export function reopenReport(report: WebReport, reviewedRules: IntakeRule[]) {
  generation++;
  get('target-panel').hidden = true;
  renderReport(report, reviewedRules);
}

let stopTrackingEvidence=()=>{};
function renderReport(report:WebReport, reviewedRules = rules){
  stopTrackingEvidence();
  const root=get('web-results');root.replaceChildren();root.append(el('h2',!report.checked?'No selected text could be checked':report.differences.length?`${report.differences.length} design ${report.differences.length===1?'error':'errors'}`:'No errors in the selected checks'),el('p',report.url,'report-url'),el('p','The report covers text the app could check against your design system.','hint'));
  if(!report.checked)root.append(el('p','Capture the page again after checking its access and loading issues, or select text that can be measured. No conformance result is available.','status error'));
  if(report.unchecked.length||report.unmappedRules.length){const details=el('details','','coverage');details.open=!report.checked;details.append(el('summary','What was not checked'));for(const line of report.unchecked)details.append(el('p',line));if(report.unmappedRules.length)details.append(el('p',`Text styles without a match: ${report.unmappedRules.join(', ')}`));root.append(details);}
  if(report.differences.length){
    const workspace=el('div','','error-workspace');
    const list=el('div','','error-index');list.setAttribute('aria-label','Design errors');
    const detail=el('section','','error-detail');
    const sidebar=el('aside','','review-sidebar');
    sidebar.setAttribute('aria-label','Finding inspector');
    const sidebarTitle=el('p','Findings','review-list-title');
    sidebarTitle.append(el('span',String(report.differences.length)));
    sidebar.append(sidebarTitle,list,detail);

    const evidence=el('section','','evidence-desk');
    const toolbar=el('div','','evidence-toolbar');
    const caption=el('span','','capture-caption');
    const next=el('button','Next affected location');
    const zoom=el('button','Actual size');zoom.type='button';
    toolbar.append(caption,zoom,next);
    const viewport=el('div','','evidence-viewport');
    viewport.tabIndex=0;viewport.setAttribute('aria-label','Scrollable page screenshot');
    const frame=el('div','','evidence-frame');
    const image=el('img');
    const marks=el('div','','evidence-marks');
    frame.append(image,marks);viewport.append(frame);evidence.append(toolbar,viewport);
    let selected=0,location=0,actualSize=false;
    const paint=()=>{
      const width=image.naturalWidth,height=image.naturalHeight;
      if(!width||!height)return;
      frame.style.width=actualSize?`${width}px`:`min(100%, ${width}px)`;
      marks.replaceChildren();
      const difference=report.differences[selected]!;
      const affected=difference.locations[location]!;
      const rects=affected.textRects?.length?affected.textRects:[affected.bounds];
      const anchor=rects[0]!;
      for(const rect of rects){
        const x=Math.max(0,rect.x),y=Math.max(0,rect.y);
        const right=Math.min(width,rect.x+rect.width),bottom=Math.min(height,rect.y+rect.height);
        if(right<=x||bottom<=y)continue;
        const highlight=el('div','','evidence-highlight');
        highlight.setAttribute('aria-hidden','true');
        Object.assign(highlight.style,{left:`${x/width*100}%`,top:`${y/height*100}%`,width:`${(right-x)/width*100}%`,height:`${(bottom-y)/height*100}%`});
        marks.append(highlight);
      }
      const occupied=new Set<string>();
      const pins:{x:number;y:number}[]=[];
      const scale=frame.clientWidth/width;
      const pinAt=(index:number,point:number,rect:typeof anchor)=>{
        const x=Math.max(0,rect.x),y=Math.max(0,rect.y);
        if(x>=width||y>=height||rect.x+rect.width<=0||rect.y+rect.height<=0)return;
        const position=`${Math.round(x)},${Math.round(y)}`;
        if(occupied.has(position))return;
        occupied.add(position);
        const pin=el('button',String(index+1),'issue-marker issue-pin');
        pin.type='button';pin.setAttribute('aria-label',`Show issue ${index+1}`);
        pin.setAttribute('aria-pressed',String(index===selected));
        const anchorX=x*scale,anchorY=y*scale;
        const centerX=Math.max(-12,anchorX-21);
        let centerY=anchorY;
        while(pins.some(item=>Math.hypot(item.x-centerX,item.y-centerY)<32))centerY+=32;
        pins.push({x:centerX,y:centerY});
        const line=el('span','','issue-leader');
        line.setAttribute('aria-hidden','true');
        const dx=centerX-anchorX,dy=centerY-anchorY;
        Object.assign(line.style,{left:`${anchorX}px`,top:`${anchorY}px`,width:`${Math.hypot(dx,dy)}px`,transform:`rotate(${Math.atan2(dy,dx)}rad)`});
        pin.style.left=`${centerX}px`;pin.style.top=`${centerY}px`;
        marks.append(line);
        pin.onclick=()=>{selected=index;location=point;show();(list.children[index] as HTMLButtonElement).focus({preventScroll:true});};
        marks.append(pin);
      };
      pinAt(selected,location,anchor);
      for(const [index,issue] of report.differences.entries()){
        if(index===selected)continue;
        const point=issue.locations.findIndex(item=>item.captureId===affected.captureId);
        const item=issue.locations[point];
        if(item)pinAt(index,point,item.textRects?.[0]??item.bounds);
      }
      const x=Math.max(0,anchor.x)*scale,y=Math.max(0,anchor.y)*scale;
      const insetX=frame.offsetLeft,insetY=frame.offsetTop;
      if(x+insetX<viewport.scrollLeft+12||x+insetX>viewport.scrollLeft+viewport.clientWidth-36)viewport.scrollLeft=x+insetX-viewport.clientWidth/3;
      if(y+insetY<viewport.scrollTop+32||y+insetY>viewport.scrollTop+viewport.clientHeight-56)viewport.scrollTop=y+insetY-viewport.clientHeight/3;
    };
    image.onload=paint;
    const resize=new ResizeObserver(()=>{if(image.complete)paint();});
    resize.observe(viewport);
    stopTrackingEvidence=()=>resize.disconnect();
    zoom.onclick=()=>{actualSize=!actualSize;zoom.textContent=actualSize?'Fit width':'Actual size';paint();};
    const show=()=>{
      detail.replaceChildren();const difference=report.differences[selected]!;const affected=difference.locations[location]!;const capture=report.captures.find(c=>c.id===affected.captureId)!;
      for(const [i,b] of [...list.children].entries()){b.classList.toggle('selected',i===selected);b.setAttribute('aria-pressed',String(i===selected));}
      detail.append(el('h3',`${difference.name}: ${difference.property==='font-size'?'text size':'text color'}`));
      const values=el('div','','error-values');
      for(const [label,value] of [['On this page',difference.actual],['Design system',difference.expected]]){
        const col=el('div');col.append(el('p',label!,'hint'),el('strong',value!));values.append(col);
      }
      detail.append(values,el('blockquote',affected.text,'affected-text'),el('p',`Suggested fix: change the ${difference.property==='font-size'?'text size':'text color'} of this text from ${difference.actual} to ${difference.expected}.`,'issue-fix'));
      caption.textContent=`${capture.width}px · ${capture.theme} preference · Location ${location+1} of ${difference.locations.length}`;
      next.type='button';next.disabled=difference.locations.length<2;
      next.onclick=()=>{location=(location+1)%difference.locations.length;show();};
      image.alt=`Captured page at ${capture.width}px with design issue markers`;
      const src=apiPath(`/api/screenshots/${report.targetId}/${capture.id}`);
      if(image.getAttribute('src')!==src){marks.replaceChildren();image.src=src;}
      else if(image.complete)paint();
      if(!affected.textRects?.length)detail.append(el('p','This capture shows the element outline. Check the page again for a text-level highlight.','hint'));
      const rule=reviewedRules.find(r=>r.id===difference.ruleId);
      const copy=el('button','Copy issue details');copy.type='button';
      copy.onclick=async()=>{
        const lines=[
          `${difference.name} · ${difference.property}`, report.url,
          `${capture.width}px · ${capture.theme} browser preference`,
          `Affected text: ${affected.text}`,
          `Change ${difference.actual} to ${difference.expected}.`,
          affected.selector && `CSS selector: ${affected.selector}`,
          rule?.evidence && `Design system: ${rule.evidence}`,
        ].filter(Boolean);
        try { await navigator.clipboard.writeText(lines.join('\n')); copy.textContent='Copied'; }
        catch { copy.textContent='Could not copy issue'; }
      };
      detail.append(copy);
      const provenance=el('details','','provenance');
      provenance.append(el('summary','Design system evidence and CSS details'),el('p',rule?.evidence??''),el('p',rule?.conditionEvidence??''));
      if(affected.selector)provenance.append(el('p',affected.selector));
      provenance.append(el('p',report.limitations.join(' ')));detail.append(provenance);
    };
    report.differences.forEach((d,i)=>{const button=el('button',`${i+1}. ${d.name}: ${d.property==='font-size'?'text size':'text color'}`);button.type='button';button.onclick=()=>{selected=i;location=0;show();};list.append(button);});workspace.append(evidence,sidebar);root.append(workspace);show();
  }
  const download=el('button','Download audit evidence');download.type='button';download.onclick=()=>{const blob=new Blob([JSON.stringify(report,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob);const a=el('a');a.href=url;a.download='audit-report.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};root.append(download);root.hidden=false;updateNavigation('report');root.scrollIntoView({behavior:'instant',block:'start'});
}
