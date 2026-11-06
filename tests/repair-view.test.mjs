import test from 'node:test';
import assert from 'node:assert/strict';
import {appendRepairAnswerNotice,createRepairPanel} from '../online/repair-view.mjs';
import {renderContent} from '../online/render.mjs';

class Node {
  constructor(tag){this.tag=tag;this.children=[];this.attributes=new Map();this.hidden=false;this.value='';if(tag==='img'){this.naturalWidth=10;this.naturalHeight=10;this.decode=async()=>{};}}
  set textContent(v){this.value=String(v);this.children=[];}
  get textContent(){return this.value+this.children.map(c=>c.textContent).join('');}
  append(...nodes){for(const n of nodes){if(n.tag==='#fragment')this.children.push(...n.children);else this.children.push(n);}}
  replaceChildren(...nodes){this.value='';this.children=[];this.append(...nodes);}
  setAttribute(k,v){this.attributes.set(k,String(v));}removeAttribute(k){this.attributes.delete(k);}
  querySelectorAll(tag){return this.children.flatMap(c=>[...(c.tag===tag?[c]:[]),...c.querySelectorAll(tag)]);}
  set innerHTML(_){throw Error('Unsafe HTML');}
}
globalThis.document={createElement:t=>new Node(t),createTextNode:t=>{const n=new Node('#text');n.textContent=t;return n;},createDocumentFragment:()=>new Node('#fragment')};
const q={bankId:'bank-test',questionId:'q_'+'1'.repeat(64),revisionDigest:'a'.repeat(64),type:'single-choice',answer:{grading:'objective',optionIds:['b']},options:[{optionId:'a',label:'A'},{optionId:'b',label:'B'}]};
const record={key:{bankId:q.bankId,questionId:q.questionId,revisionDigest:q.revisionDigest},batchId:'test',reviewStatus:'reviewed',materialLinks:[],answerCorrection:{action:'replace',originalOptionIds:['b'],correctedOptionIds:['a'],reason:'<script>不能执行</script>',evidence:['独立依据']}};
const ready={state:'ready',record,materials:[],repairDigest:'b'.repeat(64)};
const material={link:{sourceQuestionId:'q_'+'2'.repeat(64),sourceRevisionDigest:'c'.repeat(64),stemBlockIndexes:[0],evidence:'明确材料范围'},collectionTitle:'同卷',body:{format:'tiptap-portable-v1',doc:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'真实来源材料'}]}]}},mediaOccurrences:[]};
const render=(body,occurrences,signal,urls)=>renderContent(body,occurrences,async()=>new Blob(['image']),signal,urls);
const tick=()=>new Promise(resolve=>setImmediate(resolve));

test('pending repair blocks grading; successful materials precede target and correction answers wait until reveal',async()=>{
  let resolve;
  const panel=createRepairPanel({client:{get(){return new Promise(r=>resolve=r);}},question:q,renderBody:render});
  assert.equal(panel.grade(['a']).mode,'withheld');assert.match(panel.element.textContent,/正在核对/);
  resolve({...ready,materials:[material]});await panel.ready;
  assert.match(panel.element.textContent,/真实来源材料/);assert.match(panel.element.textContent,/查看答案时/);
  assert.doesNotMatch(panel.element.textContent,/参考选项：A|不能执行/);
  assert.equal(panel.grade(['a']).evaluation,'correct');
  const answer=new Node('section');appendRepairAnswerNotice(answer,q,panel.state,panel.grade(['a']));
  assert.match(answer.textContent,/勘误后参考选项：A/);assert.match(answer.textContent,/原库参考选项：B/);assert.match(answer.textContent,/以下为原库答案与解析/);
  assert.match(answer.textContent,/<script>不能执行<\/script>/);assert.equal(answer.querySelectorAll('script').length,0);
});

test('failed metadata load is visible and withheld until explicit retry finishes',async()=>{
  let calls=0,refreshes=0,invalidations=0;
  const panel=createRepairPanel({client:{refresh(){refreshes++;},async get(){if(++calls===1)throw Error('network_http_404');return ready;}},question:q,renderBody:render,onRefresh(){invalidations++;}});
  await panel.ready;assert.equal(panel.grade(['b']).mode,'withheld');assert.match(panel.element.textContent,/加载失败/);
  const version=panel.version;panel.element.querySelectorAll('button')[0].onclick();
  assert.equal(panel.grade(['a']).mode,'withheld');await tick();
  assert.equal(panel.grade(['a']).evaluation,'correct');assert.equal(panel.version,version+1);assert.equal(refreshes,1);assert.equal(invalidations,1);
});

test('image hashing/loading or decode failure withholds correction and a successful retry can recover',async()=>{
  const imageMaterial={...material,body:{format:'tiptap-portable-v1',doc:{type:'doc',content:[{type:'questionImage',attrs:{occurrenceId:'o'}}]}},mediaOccurrences:[{occurrenceId:'o',status:'ready',zone:'stem',mediaId:'m'}]};
  let fail='hash',loads=0;
  const controller=new AbortController();
  const panel=createRepairPanel({client:{refresh(){},async get(){return {...ready,materials:[imageMaterial]};}},question:q,signal:controller.signal,renderBody:async(body,occurrences,signal,urls)=>{
    const result=await renderContent(body,occurrences,async(o)=>{loads++;assert.equal(o.mediaId,'m');if(fail==='hash')throw Error('media_hash_mismatch');return new Blob(['image']);},signal,urls);
    if(fail==='decode')result.querySelectorAll('img')[0].decode=async()=>{throw Error('bad PNG');};
    return result;
  }});
  await panel.ready;assert.equal(panel.grade(['a']).mode,'withheld');
  fail='decode';panel.element.querySelectorAll('button')[0].onclick();await tick();assert.equal(panel.grade(['a']).mode,'withheld');
  fail=null;panel.element.querySelectorAll('button')[0].onclick();await tick();assert.equal(panel.grade(['a']).mode,'corrected');assert.equal(loads,3);controller.abort();
});

test('late response after navigation does not disclose materials or change grading',async()=>{
  let resolve;const controller=new AbortController();
  const panel=createRepairPanel({client:{get(){return new Promise(r=>resolve=r);}},question:q,signal:controller.signal,renderBody:render});
  controller.abort();resolve({...ready,materials:[material]});await panel.ready;
  assert.doesNotMatch(panel.element.textContent,/真实来源材料/);assert.equal(panel.grade(['a']).mode,'withheld');
});

test('missing records hide the preamble; needs-review withhold stays explicitly self-evaluated',async()=>{
  const absent=createRepairPanel({client:{async get(){return {state:'missing'};}},question:q,renderBody:render});await absent.ready;
  assert.equal(absent.element.hidden,true);assert.equal(absent.grade(['b']).evaluation,'correct');
  const held=createRepairPanel({client:{async get(){return {...ready,record:{...record,reviewStatus:'needs-review',answerCorrection:{...record.answerCorrection,action:'withhold',correctedOptionIds:[]}}};}},question:q,renderBody:render});await held.ready;
  assert.equal(held.grade(['b']).mode,'withheld');const answer=new Node('section');appendRepairAnswerNotice(answer,q,held.state,held.grade(['b']));
  assert.match(answer.textContent,/暂停自动判分/);assert.match(answer.textContent,/不能将其视为已核实结论/);
});
