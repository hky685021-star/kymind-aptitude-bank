import test from 'node:test';
import assert from 'node:assert/strict';
import {createSupplementControls,renderSupplement} from '../online/supplement-view.mjs';

// Minimal DOM contract, deliberately without innerHTML: integration/visual checks
// live separately in browser-saved-supplements.py and require a usable browser.
class Node {
  constructor(tag) { this.tag=tag;this.children=[];this.attributes=new Map();this.hidden=false;this.value=''; }
  set textContent(value) { this.value=String(value);this.children=[]; }
  get textContent() { return this.value+this.children.map(n=>n.textContent).join(''); }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.value='';this.children=[...nodes]; }
  setAttribute(key,value) { this.attributes.set(key,String(value)); }
  getAttribute(key) { return this.attributes.get(key); }
  removeAttribute(key) { this.attributes.delete(key); }
  set innerHTML(_) { throw Error('Unsafe HTML rendering'); }
}
globalThis.document={createElement:tag=>new Node(tag)};
const tick=()=>new Promise(resolve=>setImmediate(resolve));
const ready={state:'ready',ai:{batchId:'test',reviewStatus:'reviewed',sourceIssues:[],focusAnalysis:'独立推理',quickTip:'本题无可靠秒杀技巧'},models:null};
const childButton=(panel,text)=>panel.children.find(n=>n.tag==='button'&&n.textContent===text);

test('each question has independent accessible AI and model toggles, initially collapsed and lazy',async()=>{
  let calls=0;
  const controls=createSupplementControls({client:{async get(){calls++;return ready;}},question:{}});
  const [ai,model]=controls.buttons.children,[aiPanel,modelPanel]=controls.panels.children;
  assert.equal(calls,0);assert.equal(ai.textContent,'AI解析');assert.equal(model.textContent,'模型索引');
  assert.equal(aiPanel.hidden,true);assert.equal(modelPanel.hidden,true);
  assert.equal(ai.getAttribute('aria-controls'),aiPanel.id);
  ai.onclick();await tick();
  assert.equal(calls,1);assert.equal(aiPanel.hidden,false);assert.equal(modelPanel.hidden,true);
  assert.match(aiPanel.textContent,/重点解析独立推理秒杀技巧本题无可靠秒杀技巧/);
  model.onclick();await tick();assert.equal(modelPanel.hidden,false);assert.equal(aiPanel.hidden,false);
  ai.onclick();assert.equal(aiPanel.hidden,true);assert.equal(modelPanel.hidden,false);
  ai.onclick();await tick();assert.equal(calls,2);assert.equal(ai.getAttribute('aria-expanded'),'true');
  const other=createSupplementControls({client:{async get(){return ready;}},question:{}});
  assert.notEqual(other.panels.children[0].id,aiPanel.id);assert.equal(other.panels.children[0].hidden,true);
});

test('rapid close and reopen coalesces work and a late response never reopens a collapsed panel',async()=>{
  let resolve,calls=0;
  const controls=createSupplementControls({client:{get(){calls++;return new Promise(r=>resolve=r);}},question:{}});
  const button=controls.buttons.children[0],panel=controls.panels.children[0];
  button.onclick();button.onclick();button.onclick();button.onclick();
  assert.equal(calls,1);resolve(ready);await tick();
  assert.equal(panel.hidden,true);assert.equal(button.getAttribute('aria-expanded'),'false');
  button.onclick();await tick();assert.equal(calls,1);assert.match(panel.textContent,/独立推理/);
});

test('failure provides explicit retry and never states that saved content is absent',async()=>{
  let calls=0,refreshes=0;
  const controls=createSupplementControls({client:{refresh(){refreshes++;},async get(){if(++calls===1)throw Error('network_http_404');return {state:'missing'};}},question:{}});
  const button=controls.buttons.children[0],panel=controls.panels.children[0];
  button.onclick();await tick();assert.match(panel.textContent,/补充加载失败/);assert.doesNotMatch(panel.textContent,/尚未保存/);
  childButton(panel,'重试加载').onclick();await tick();
  assert.equal(refreshes,1);assert.equal(calls,2);assert.match(panel.textContent,/尚未保存 AI 解析/);
  childButton(panel,'刷新补充索引').onclick();await tick();assert.equal(refreshes,2);
});

test('abort on navigation prevents late old-question content from rendering',async()=>{
  let resolve;const controller=new AbortController();
  const controls=createSupplementControls({client:{get(){return new Promise(r=>resolve=r);}},question:{},signal:controller.signal});
  controls.buttons.children[0].onclick();controller.abort();resolve(ready);await tick();
  assert.doesNotMatch(controls.panels.children[0].textContent,/独立推理/);
});

test('public HTML, Markdown and TeX remain literal text and cannot add elements or links',()=>{
  const panel=new Node('section'),unsafe='<img src=x onerror=alert(1)><script>alert(1)</script> [x](javascript:alert(1)) \\href{evil}{x}';
  renderSupplement(panel,'ai',{...ready,ai:{...ready.ai,focusAnalysis:unsafe}});
  assert.ok(panel.textContent.includes(unsafe));
  assert.ok(panel.children.every(n=>['h4','p'].includes(n.tag)));
});

test('blocked and stale states are explicit and models retain empty dimensions and pending terms',()=>{
  const panel=new Node('section');
  renderSupplement(panel,'ai',{...ready,ai:{...ready.ai,reviewStatus:'blocked',sourceIssues:['missing-material']}});
  assert.match(panel.textContent,/已阻断/);assert.match(panel.textContent,/缺材料/);
  renderSupplement(panel,'ai',{state:'stale'});assert.match(panel.textContent,/未展示旧内容/);assert.doesNotMatch(panel.textContent,/独立推理/);
  renderSupplement(panel,'models',{state:'ready',models:{batchId:'test',reviewStatus:'pending',knowledgeCategory:'逻辑',basis:'证据',pendingReasons:['词条待复核'],dimensions:{concept:[],model:[{label:'论证结构',definition:'定义',code:'draft.logic',reviewStatus:'pending'}],target:[],context:[]}}});
  assert.match(panel.textContent,/候选模型索引/);assert.match(panel.textContent,/暂无准确映射/);assert.match(panel.textContent,/待审核词条/);assert.match(panel.textContent,/词条待复核/);
});
