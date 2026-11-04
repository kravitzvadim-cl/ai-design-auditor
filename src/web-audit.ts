import { createHash, randomUUID } from 'node:crypto';
import { writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { checkedUrl, fetchPublic } from './intake-network.js';
import { normalizeColor, normalizePixels, sameValue } from './normalize.js';
import { createCaptureDirectory } from './io.js';
import { validSize, validColor } from './intake.js';
import type { IntakeRule } from './intake.js';
import type { Candidate, Mapping } from './openrouter.js';
export type Measured = Candidate & { size: string; color: string; bounds: { x: number; y: number; width: number; height: number }; rootSize: string; parentSize: string; references?: Record<string,string> };
export type WebCapture = { id: string; width: number; theme: 'light'|'dark'; screenshot: string; elements: Measured[]; issues: string[]; truncated: boolean };
export type WebTarget = { id: string; url: string; folder: string; candidates: Candidate[]; captures: WebCapture[]; resources: { url: string; sha256: string }[]; capturedAt: string; browser: string };
export type WebDifference = { ruleId: string; name: string; property: 'font-size'|'color'; expected: string; actual: string; locations: { captureId: string; elementId: string; text: string; bounds: Measured['bounds'] }[] };
export type WebReport = { id: string; targetId: string; url: string; createdAt: string; differences: WebDifference[]; unchecked: string[]; unmappedRules: string[]; captures: WebCapture[]; checked: number; limitations: string[] };
export type PublicReader = typeof fetchPublic;
export async function inspectWebsite(raw: string, directory: string, themes: ('light'|'dark')[] = ['light'], reader: PublicReader = fetchPublic, expectedSizes: string[] = []): Promise<WebTarget> {
  const url=checkedUrl(raw); url.hash=''; const id=randomUUID(); const folder=`reports/web-audits/${id}`; const output=await createCaptureDirectory(folder,directory);
  // Public pages execute untrusted scripts. Never disable Chromium's sandbox for
  // this path, even when a container runtime cannot provide the required support.
  const browser=await chromium.launch({headless:true,chromiumSandbox:true,executablePath:process.env.CHROMIUM ?? chromium.executablePath(),
    args:['--proxy-server=http://127.0.0.1:1','--proxy-bypass-list=<-loopback>','--disable-quic','--force-webrtc-ip-handling-policy=disable_non_proxied_udp']});
  const result: WebTarget={id,url:url.href,folder,candidates:[],captures:[],resources:[],capturedAt:new Date().toISOString(),browser:browser.version()};
  const cache=new Map<string,Promise<Awaited<ReturnType<PublicReader>>>>(); let totalBytes=0; let requests=0;
  try {
    for (const theme of themes) for (const width of [390,1440]) {
      const context=await browser.newContext({viewport:{width,height:900},deviceScaleFactor:1,colorScheme:theme,serviceWorkers:'block',acceptDownloads:false});
      const issues:string[]=[]; const capture:WebCapture={id:`${theme}-${width}`,width,theme,screenshot:`${theme}-${width}.png`,elements:[],issues,truncated:false};
      await context.routeWebSocket('**/*',socket=>socket.close());
      await context.route('**/*',async route=>{
        const request=route.request();
        try {
          const resourceUrl=checkedUrl(request.url());
          if (!['GET','HEAD'].includes(request.method()) || (request.isNavigationRequest() && (request.frame()!==request.frame().page().mainFrame() || resourceUrl.href!==url.href))) { await route.abort(); return; }
          // Every browser request uses the DNS-pinned public reader. Untrusted page JS
          // has no direct network path, including to private services or writes.
          if(!cache.has(resourceUrl.href)) {
            if(++requests>100) throw new Error('Resource count limit reached.');
            cache.set(resourceUrl.href,(async()=>{const resource=await reader(resourceUrl.href);checkedUrl(resource.finalUrl);totalBytes+=resource.bytes.length;if(totalBytes>24_000_000)throw new Error('Page resource limit reached.');result.resources.push({url:resource.finalUrl,sha256:createHash('sha256').update(resource.bytes).digest('hex')});return resource;})());
          }
          const resource=await cache.get(resourceUrl.href)!;
          await route.fulfill({status:200,contentType:resource.type,body:resource.bytes});
        } catch { if(['document','stylesheet','font'].includes(request.resourceType()))issues.push('A document, stylesheet or font could not be loaded within the public-page limits.');await route.abort(); }
      });
      const page=await context.newPage();page.setDefaultTimeout(15000);page.on('dialog',dialog=>void dialog.dismiss());page.on('pageerror',()=>issues.push('A page script failed.'));
      try {
        await page.goto(url.href,{waitUntil:'load',timeout:25000});
        await page.evaluate(async()=>{await document.fonts.ready;});
        if(await page.evaluate(()=>[...document.fonts].some(f=>f.status==='error')))issues.push('A page font did not load.');
        // Bounded scroll triggers lazy content; never clicks or submits the target.
        await page.evaluate(async()=>{for(let y=0;y<Math.min(document.documentElement.scrollHeight,10000);y+=800){scrollTo(0,y);await new Promise(resolve=>setTimeout(resolve,40));}scrollTo(0,0);});
        const observed=await page.evaluate((expectedSizes)=>{
          const all=[...document.querySelectorAll<HTMLElement>('h1,h2,h3,h4,h5,h6,p,li,dt,dd,label,legend,button,a,summary,th,td,span')];
          const items=all.filter(e=>{const r=e.getBoundingClientRect();const s=getComputedStyle(e);return r.width>0&&r.height>0&&s.visibility==='visible'&&s.opacity!=='0'&&!!e.textContent?.trim()&&([...e.childNodes].some(n=>n.nodeType===Node.TEXT_NODE&&!!n.textContent?.trim())||/^H[1-6]$|^(P|BUTTON|LABEL|LEGEND|A|SUMMARY)$/.test(e.tagName));});
          const path=(e:Element)=>{const parts:string[]=[];let at:Element|null=e;while(at&&at.tagName!=='HTML'){const tag=at.tagName.toLowerCase(),parent:Element|null=at.parentElement;parts.unshift(tag+':nth-of-type('+([...(parent?.children??[])].filter(child=>child.tagName===at!.tagName).indexOf(at)+1)+')');at=parent;}return 'html > '+parts.join(' > ');};
          return {truncated:items.length>250,tooTall:document.documentElement.scrollHeight>10000,frames:document.querySelectorAll('iframe,frame').length,shadows:[...document.querySelectorAll('*')].some(e=>e.shadowRoot),items:items.slice(0,250).map(e=>{const s=getComputedStyle(e),r=e.getBoundingClientRect();const references:Record<string,string>={};
            for(const size of expectedSizes)if(CSS.supports('font-size',size)){const parent=document.createElement('div'),reference=document.createElement('span');parent.style.setProperty('position','fixed','important');parent.style.setProperty('visibility','hidden','important');parent.style.setProperty('font-size',getComputedStyle(e.parentElement??document.documentElement).fontSize,'important');reference.style.setProperty('font-size',size,'important');parent.append(reference);document.body.append(parent);references[size]=getComputedStyle(reference).fontSize;parent.remove();}
            return {references,selector:path(e),tag:e.tagName.toLowerCase(),text:e.textContent!.trim().slice(0,200),classes:String(e.className).slice(0,200),role:e.getAttribute('role')??'',size:s.fontSize,color:s.color,rootSize:getComputedStyle(document.documentElement).fontSize,parentSize:getComputedStyle(e.parentElement??document.documentElement).fontSize,bounds:{x:r.x+scrollX,y:r.y+scrollY,width:r.width,height:r.height}};})};
        }, [...new Set(expectedSizes)].filter(validSize));
        if(observed.tooTall)throw new Error('This page exceeds the 10,000px capture limit. Use a smaller page.');
        capture.truncated=observed.truncated;
        if(observed.frames||observed.shadows)issues.push('Embedded frames or shadow-root content are outside this capture.');
        capture.elements=observed.items.map(item=>({...item,id:'e'+createHash('sha256').update(JSON.stringify([item.selector,item.tag,item.text])).digest('hex').slice(0,12)}));
        if(!capture.elements.length)issues.push('No visible supported text elements were found.');
        await page.screenshot({path:join(output,capture.screenshot),fullPage:true,timeout:15000});
      } catch(error){throw new Error(error instanceof Error&&error.message.includes('capture limit')?error.message:'The public page could not be captured. Check its address or try a smaller accessible page.');}
      finally{await context.close();}
      result.captures.push(capture);
    }
    const map=new Map<string,Candidate>();for(const c of result.captures)for(const e of c.elements)map.set(e.id,{id:e.id,selector:e.selector,tag:e.tag,text:e.text,classes:e.classes,role:e.role});
    result.candidates=[...map.values()].slice(0,250);
    await writeFile(join(output,'target.json'),JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});return result;
  } finally{await browser.close();}
}
function expectedSize(size:string,element:Measured):string|null {
  if(!validSize(size))return null;const n=parseFloat(size);
  if(size.endsWith('rem'))return `${n*parseFloat(element.rootSize)}px`;
  if(size.endsWith('em'))return `${n*parseFloat(element.parentSize)}px`;
  if(size.endsWith('pt'))return `${n*96/72}px`;
  return size.endsWith('px')?size:null;
}
export function compareWebsite(target:WebTarget,rules:IntakeRule[],mappings:Mapping[]):WebReport {
  const known=new Set(target.candidates.map(c=>c.id));const seen=new Set<string>();
  for(const mapping of mappings)if(!rules.some(r=>r.id===mapping.ruleId)||seen.has(mapping.ruleId)||!Array.isArray(mapping.elementIds)||mapping.elementIds.length>250||mapping.elementIds.some(id=>!known.has(id)))throw new Error('Choose only rules and elements from this capture.');else seen.add(mapping.ruleId);
  const differences=new Map<string,WebDifference>();const unchecked=new Set<string>();let checked=0;
  for(const capture of target.captures){
    if(capture.issues.length){unchecked.add(`${capture.width}px ${capture.theme}: page loading or unsupported-content issues. No errors asserted for this capture.`);continue;}
    if(capture.truncated)unchecked.add(`${capture.width}px ${capture.theme}: first 250 supported text elements only.`);
    for(const mapping of mappings){const rule=rules.find(r=>r.id===mapping.ruleId)!;
      if(rule.theme!=='all'&&rule.theme!==capture.theme||rule.aboveWidth!==undefined&&capture.width<=rule.aboveWidth||rule.maxWidth!==undefined&&capture.width>rule.maxWidth)continue;
      for(const id of mapping.elementIds){const e=capture.elements.find(e=>e.id===id);if(!e)continue;
        for(const property of ['font-size','color'] as const){const raw=property==='font-size'?rule.size:rule.color;if(!raw)continue;
          const expected=property==='font-size'?(e.references?.[raw]??expectedSize(raw,e)):validColor(raw)?raw:null;const actual=property==='font-size'?e.size:e.color;
          if(!expected){unchecked.add(`${rule.name}: ${raw} cannot be resolved in this website context.`);continue;}
          const a=property==='font-size'?normalizePixels(expected):normalizeColor(expected),b=property==='font-size'?normalizePixels(actual):normalizeColor(actual);
          if(!a||!b){unchecked.add(`${rule.name}: value could not be compared.`);continue;}checked++;
          if(!sameValue(a,b)){const key=JSON.stringify([rule.id,property,expected,actual]);const group=differences.get(key)??{ruleId:rule.id,name:rule.name,property,expected,actual,locations:[]};group.locations.push({captureId:capture.id,elementId:e.id,text:e.text,bounds:e.bounds});differences.set(key,group);}
        }
      }
    }
  }
  return {id:randomUUID(),targetId:target.id,url:target.url,createdAt:new Date().toISOString(),differences:[...differences.values()],unchecked:[...unchecked],unmappedRules:rules.filter(r=>!mappings.some(m=>m.ruleId===r.id&&m.elementIds.length)).map(r=>r.name),captures:target.captures,checked,limitations:['Only reviewed rules and confirmed element mappings are checked. This is partial coverage, not whole-page conformance.','390px and 1440px, current Chromium, static text size/color. Browser color preference is requested; site-specific theme toggles are not operated.','Screenshots support location review. Source intent never comes from the measured page.']};
}
export async function saveWebReport(report:WebReport,target:WebTarget,rules:IntakeRule[],mappings:Mapping[],directory:string){
  const output=await createCaptureDirectory(`${target.folder}/results/${report.id}`,directory);
  await writeFile(join(output,'report.json'),JSON.stringify({report,rules,mappings},null,2)+'\n',{flag:'wx',mode:0o600});
}
export async function screenshotBytes(target:WebTarget,captureId:string,directory:string){const c=target.captures.find(c=>c.id===captureId);if(!c)throw new Error('Unknown capture.');return readFile(join(directory,target.folder,c.screenshot));}
