import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { CheapInterpreter, CHEAP_MODEL } from '../src/openrouter.js';
import { sourceFromText } from '../src/intake.js';
import type { IntakeRule } from '../src/intake.js';
import { inspectWebsite, compareWebsite } from '../src/web-audit.js';
import type { PublicReader, WebTarget } from '../src/web-audit.js';
import { intakeServer } from '../src/intake-server.js';
const response=(value:unknown)=>new Response(JSON.stringify({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}],usage:{prompt_tokens:300,completion_tokens:100,cost:0.00007}}),{headers:{'Content-Type':'application/json'}});
const source=()=>sourceFromText('Published text','Body text: 19px #0b0c0c\nSmall screens at widths up to 640px use Body text: 16px.');
const suggestion=(overrides:Record<string,unknown>={})=>({name:'Body text',size:'19px',color:'#0b0c0c',theme:'all',aboveWidth:null,maxWidth:null,evidence:'Body text: 19px #0b0c0c',conditionEvidence:'',...overrides});

test('OpenRouter integration pins the cheap model, prices, JSON format, limits and cache without exposing the key',async()=>{
  let calls=0;
  const ai=new CheapInterpreter({key:'test-private-key',fetcher:async(url,options)=>{
    calls++;assert.equal(url,'https://openrouter.ai/api/v1/chat/completions');assert.equal(options?.redirect,'error');
    const body=JSON.parse(String(options?.body));assert.equal(body.model,CHEAP_MODEL);assert.equal(body.max_tokens,3000);assert.equal(body.provider.allow_fallbacks,false);assert.equal(body.provider.data_collection,'deny');assert.deepEqual(body.provider.max_price,{prompt:0.15,completion:0.6});assert.equal(body.response_format.json_schema.strict,true);assert.equal(body.tools,undefined);
    return response({rules:[suggestion()],notes:[]});
  }});
  const s=source();const first=await ai.extract(s);const second=await ai.extract(s);assert.equal(calls,1);assert.equal(second.receipt.cached,true);assert.equal(first.rules[0]!.size,'19px');assert.equal(first.receipt.chargedUSD,0.00007);assert.ok(!JSON.stringify(first).includes('test-private-key'));
  const budget=new CheapInterpreter({key:'test',budgetUSD:0,fetcher:async()=>{throw new Error('must not call');}});await assert.rejects(budget.extract(s),/budget/);
  const error=new CheapInterpreter({key:'test-private-key',fetcher:async()=>new Response('test-private-key',{status:401})});await assert.rejects(error.extract(s),e=>e instanceof Error&&e.message.includes('401')&&!e.message.includes('test-private-key'));
});

test('model output cannot introduce undocumented values, excluded properties or unsupported breakpoint claims',async()=>{
  for(const invalid of [suggestion({size:'20px',color:''}),suggestion({evidence:'Invented source'}),suggestion({name:'Line height'}),suggestion({aboveWidth:700,conditionEvidence:'Small screens at widths up to 640px use Body text: 16px.'}),suggestion({'font-weight':700})]){
    const ai=new CheapInterpreter({key:'test',fetcher:async()=>response({rules:[invalid],notes:[]})});await assert.rejects(ai.extract(source()));
  }
  const ai=new CheapInterpreter({key:'test',fetcher:async()=>response({rules:[suggestion({size:'16px',color:'',maxWidth:640,evidence:'Small screens at widths up to 640px use Body text: 16px.',conditionEvidence:'Small screens at widths up to 640px use Body text: 16px.'})],notes:[]})});assert.equal((await ai.extract(source())).rules[0]!.maxWidth,640);
  const partial=new CheapInterpreter({key:'test',fetcher:async()=>response({rules:[suggestion({color:'#000000'}),suggestion({name:'Line height'})],notes:[]})});const kept=await partial.extract(source());assert.equal(kept.rules.length,1);assert.equal(kept.rules[0]!.size,'19px');assert.equal(kept.rules[0]!.color,'');assert.ok(kept.notes.length>0);
  const incomplete=new CheapInterpreter({key:'test',fetcher:async()=>new Response(JSON.stringify({choices:[{finish_reason:'length',message:{content:'{}'}}]}))});await assert.rejects(incomplete.extract(source()),/incomplete/);
});

const makeRule=(patch:Partial<IntakeRule>={}):IntakeRule=>({id:'body',name:'Body text',size:'19px',color:'#0b0c0c',theme:'all',sourceId:'manual',evidence:'Body text: 19px #0b0c0c',...patch});
const target=():WebTarget=>({id:'target',url:'https://fixture.example/page',folder:'reports/fixture',capturedAt:new Date().toISOString(),browser:'fixture',resources:[],candidates:[{id:'e1',selector:'p',tag:'p',text:'Sample paragraph',classes:'body',role:''}],captures:[390,1440].map(width=>({id:`light-${width}`,width,theme:'light',screenshot:'sample.png',issues:[],truncated:false,elements:[{id:'e1',selector:'p',tag:'p',text:'Sample paragraph',classes:'body',role:'',size:'17px',color:'rgb(255, 0, 0)',rootSize:'16px',parentSize:'16px',bounds:{x:20,y:30,width:200,height:30}}]}))});

test('website comparisons group repeated errors and preserve width, unit and failed-capture boundaries',()=>{
  const t=target();let report=compareWebsite(t,[makeRule()],[{ruleId:'body',elementIds:['e1']}]);assert.equal(report.differences.length,2);assert.equal(report.differences[0]!.locations.length,2);assert.equal(report.checked,4);
  const narrow=makeRule({color:'',size:'17px',maxWidth:390});report=compareWebsite(t,[narrow],[{ruleId:'body',elementIds:['e1']}]);assert.equal(report.differences.length,0);assert.equal(report.checked,1);
  t.captures[0]!.issues.push('Font failed');report=compareWebsite(t,[makeRule()],[{ruleId:'body',elementIds:['e1']}]);assert.equal(report.checked,2);assert.equal(report.unchecked.length,1);
  const relative=makeRule({size:'1.0625rem',color:''});assert.equal(compareWebsite(target(),[relative],[{ruleId:'body',elementIds:['e1']}]).differences.length,0);
  const unsupported=makeRule({size:'17sp',color:''});assert.equal(compareWebsite(target(),[unsupported],[{ruleId:'body',elementIds:['e1']}]).unchecked.length,1);
  assert.throws(()=>compareWebsite(target(),[makeRule()],[{ruleId:'unknown',elementIds:['e1']}]),/Choose only/);
  assert.throws(()=>compareWebsite(target(),[makeRule()],[{ruleId:'body',elementIds:['not-captured']}]),/Choose only/);
});

test('model mapping sees semantic candidates and rejects invented element IDs',async()=>{
  const ai=new CheapInterpreter({key:'test',fetcher:async(_url,options)=>{const body=JSON.parse(String(options?.body));const input=JSON.parse(body.messages[1].content).input;assert.equal(input.candidates[0].size,undefined);assert.equal(input.candidates[0].color,undefined);return response({mappings:[{ruleId:'body',elementIds:['e1']}]});}});
  const result=await ai.map([makeRule()],target().candidates);assert.equal(result.mappings[0]!.elementIds[0],'e1');
  const bad=new CheapInterpreter({key:'test',fetcher:async()=>response({mappings:[{ruleId:'body',elementIds:['invented']}]})});await assert.rejects(bad.map([makeRule()],target().candidates),/unknown rule or element/);
});

test('public capture uses a guarded reader, rejects local targets, blocks page writes and resolves source-backed relative sizes', {timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'auditor-public-'));const requests:string[]=[];
  const reader:PublicReader=async url=>{requests.push(url);return {bytes:Buffer.from('<!doctype html><html><head><style>html{font-size:16px}p{font-size:17px;color:#0b0c0c}</style></head><body><p>Public fixture</p><script>fetch("https://fixture.example/write",{method:"POST"}).catch(()=>{});fetch("http://127.0.0.1/private").catch(()=>{});document.querySelector("p").textContent=innerWidth<820?"Mobile fixture":"Desktop fixture";</script></body></html>'),type:'text/html',finalUrl:url};};
  try{await assert.rejects(inspectWebsite('http://127.0.0.1/',directory,['light'],reader));const captured=await inspectWebsite('https://fixture.example/',directory,['light'],reader,['1.0625rem']);assert.deepEqual(requests,['https://fixture.example/']);assert.equal(captured.captures.length,2);assert.equal(captured.candidates.length,2,'Different responsive text at the same DOM position needs distinct mapping IDs.');assert.notEqual(captured.captures[0]!.elements[0]!.id,captured.captures[1]!.elements[0]!.id);assert.ok(captured.captures.every(c=>!c.issues.length&&c.elements[0]!.references?.['1.0625rem']==='17px'));assert.equal(compareWebsite(captured,[makeRule({size:'1.0625rem'})],[{ruleId:'body',elementIds:[captured.candidates[0]!.id]}]).differences.length,0);}finally{await rm(directory,{recursive:true,force:true});}
});

test('browser runs an automatic audit and marks issues without mapping checkboxes', {timeout:60000},async()=>{
  const directory=await mkdtemp(join(tmpdir(),'auditor-web-flow-'));
  const ai=new CheapInterpreter({key:'test',fetcher:async(_url,options)=>{const body=JSON.parse(String(options?.body));const input=JSON.parse(body.messages[1].content).input;if(input.candidates)return response({mappings:input.rules.map((r:IntakeRule)=>({ruleId:r.id,elementIds:[input.candidates[0].id]}))});return response({rules:[suggestion()],notes:[]});}});
  const fixtureReader:PublicReader=async url=>({bytes:Buffer.from('<!doctype html><html><head><style>body{margin:20px;font:16px Arial}p{font-size:17px;color:#0b0c0c}p[data-color]{font-size:19px;color:#ff0000}</style></head><body><nav><p>Navigation text</p></nav><main><p>Sample paragraph</p><p data-color>Second paragraph</p></main></body></html>'),type:'text/html',finalUrl:url});
  const server=intakeServer(directory,{interpreter:ai,inspect:async(url,dir,themes,_reader,sizes)=>{const t=await inspectWebsite(url,dir,themes,fixtureReader,sizes);if(url.includes('/failed'))for(const c of t.captures)c.issues.push('Fixture load failure');return t;}});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM??chromium.executablePath()});
  try{const p=await browser.newPage({viewport:{width:390,height:844}});const errors:string[]=[];p.on('pageerror',e=>errors.push(e.message));await p.goto(`http://127.0.0.1:${(server.address() as {port:number}).port}`);
    await p.getByLabel('Design system link').fill('Body text: 19px #0b0c0c');await p.getByRole('button',{name:'Load design system',exact:true}).click();await p.getByRole('button',{name:'Interpret Pasted guidelines with AI'}).waitFor();await p.getByRole('button',{name:'Interpret Pasted guidelines with AI'}).click();await p.waitForFunction(()=>document.querySelector('.source')?.textContent?.includes('AI suggestions'));
    await p.getByRole('button',{name:'Confirm and continue',exact:true}).click();await p.locator('#target-panel').waitFor({state:'visible'});
    await p.getByLabel('Page URL').fill('https://fixture.example/page');
    await p.getByRole('button',{name:'Check this page',exact:true}).click();
    await p.getByRole('heading',{name:'2 design errors',exact:true}).waitFor();
    await p.getByText('Adjust what was checked',{exact:true}).waitFor();
    assert.equal(await p.locator('#mapping-panel').getAttribute('open'),null);
    assert.equal(await p.getByText('Issue 1',{exact:true}).isVisible(),true);
    assert.match(await p.locator('.error-detail').innerText(),/Suggested fix: change the text size of this text from 17px to 19px/);
    assert.doesNotMatch(await p.locator('.error-detail').innerText(),/Navigation text/);
    await p.getByRole('button',{name:'Show issue 2',exact:true}).click();
    assert.match(await p.locator('.error-detail').innerText(),/Second paragraph/);
    await p.locator('#web-results .error-index button').first().click();
    assert.equal(await p.locator('#web-results .error-index button').count(),2);assert.equal(await p.getByText('Matches',{exact:true}).count(),0);const image=p.locator('#web-results img');await image.waitFor();await p.waitForFunction(()=>document.querySelector<HTMLImageElement>('#web-results img')?.naturalWidth!>0);assert.ok((await image.getAttribute('src'))?.startsWith('/api/screenshots/'));
    await p.getByRole('button',{name:'Next affected location',exact:true}).click();assert.match(await p.locator('.error-detail').innerText(),/1440px/);assert.equal(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);assert.deepEqual(errors,[]);
    const files=await import('node:fs/promises');const targets=await files.readdir(join(directory,'reports/web-audits'));const resultFolder=join(directory,'reports/web-audits',targets[0]!,'results');const ids=await files.readdir(resultFolder);const saved=JSON.parse(await readFile(join(resultFolder,ids[0]!,'report.json'),'utf8'));assert.equal(saved.report.differences.length,2);
    if(process.env.AUDITOR_VISUAL_EVIDENCE){const out=process.env.AUDITOR_VISUAL_EVIDENCE;await mkdir(out,{recursive:true});for(const width of [1440,819,390]){await p.setViewportSize({width,height:900});await p.locator('#web-results').scrollIntoViewIfNeeded();await p.locator('#web-results').screenshot({path:join(out,`errors-${width}.png`)});await p.evaluate(()=>scrollTo(0,0));await p.screenshot({path:join(out,`setup-${width}.png`)});}await files.writeFile(join(out,'fixture-verification.json'),JSON.stringify({fixture:true,widths:[1440,819,390],errors:errors,report:saved.report},null,2));}

    await p.getByLabel('Page URL').fill('https://fixture.example/changed');assert.equal(await p.locator('#mapping-panel').isHidden(),true);assert.equal(await p.locator('#web-results').isHidden(),true);assert.equal(await p.locator('#run-audit').isDisabled(),true);
    await p.getByLabel('Browser appearance').selectOption('light');assert.equal(await p.locator('#mapping-panel').isHidden(),true);
    await p.getByLabel('Page URL').fill('https://fixture.example/failed');await p.getByRole('button',{name:'Check this page',exact:true}).click();await p.getByRole('heading',{name:'No selected text could be checked',exact:true}).waitFor();assert.equal(await p.getByRole('heading',{name:'No errors in the selected checks',exact:true}).count(),0);assert.equal(await p.locator('#web-results .coverage').getAttribute('open'),'');assert.match(await p.locator('#web-results').innerText(),/No conformance result is available/);
    if(process.env.AUDITOR_VISUAL_EVIDENCE){for(const width of [1440,819,390]){await p.setViewportSize({width,height:900});await p.locator('#web-results').screenshot({path:join(process.env.AUDITOR_VISUAL_EVIDENCE,`unchecked-${width}.png`)});}}
    await p.getByLabel('Text style name').first().fill('Changed unsaved');assert.equal(await p.locator('#target-panel').isHidden(),true);assert.equal(await p.locator('#web-results').isHidden(),true);
  }finally{await browser.close();await new Promise<void>(resolve=>server.close(()=>resolve()));await rm(directory,{recursive:true,force:true});}
});
