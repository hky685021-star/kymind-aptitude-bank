import {openBank,saveProgress,readProgress} from './core.mjs';
import {renderContent} from './render.mjs';
import {createSearchClient} from './search-client.mjs';
import {createNavigationView} from './navigation-view.mjs';
import {createExamSession} from './exam-session.mjs';
import {createSavedSupplements} from './saved-supplements.mjs';
import {createSupplementControls} from './supplement-view.mjs';
import {createQuestionRepairs} from './question-repairs.mjs';
import {createRepairPanel,appendRepairAnswerNotice} from './repair-view.mjs';
const $=id=>document.getElementById(id),base=new URL('../original/bank-civil-aptitude/',location.href);
// Static introduction only: no tracking, network prefetch or native capabilities.
const introDialog=$('kymind-intro-dialog'),introOpen=$('kymind-intro-open');
if(introDialog&&introOpen){
  introOpen.onclick=()=>introDialog.showModal();
  const closeIntro=()=>{introDialog.close();introOpen.focus();};
  $('kymind-intro-close').onclick=closeIntro;
  introDialog.addEventListener('click',event=>{if(event.target===introDialog){const rect=introDialog.getBoundingClientRect();if(event.clientX<rect.left||event.clientX>rect.right||event.clientY<rect.top||event.clientY>rect.bottom)closeIntro();}});
  introDialog.addEventListener('close',()=>introOpen.focus());
  introDialog.querySelector('details')?.setAttribute('open','');
}
const scopeIds=new Set();let collectionTab='paper',examPaperId='',ungroupedScope=false;
let scopeDraft=null;
let savedSupplements,questionRepairs,currentRepair;
let bank,current,queue=[],position=0,serial=0,loadController,searchController,urls=[],selected=[],collections=[],submitFlight;
let searchOffset=0,searchClient,searchGeneration=0,searchInput,searchFlight=Promise.resolve();
function status(text){$('status').textContent=text;}
function fail(error){if(error.name==='AbortError'||error.message==='cancelled')return;status(`未完成：${error.message||error}。本地练题请确认启动终端仍在运行；在线练题请检查网络。校验失败不会显示未验证内容。`);}
function element(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
const typeNames={'single-choice':'单选题','multiple-choice':'多选题','true-false':'判断题','short-answer':'简答题','essay':'论述题'};
let suiteMode=false,suiteObserver;
const navigation=createNavigationView({list:$('list'),grid:$('question-grid'),count:$('list-count')},(item,index)=>{position=index;if(suiteMode){const card=[...$('question').querySelectorAll('.suite-card')].find(c=>c.dataset.questionId===item.questionId);card?.scrollIntoView({block:'start',behavior:'smooth'});navigation.select(item.questionId);return;}void select(item).catch(fail);});
function actions(){$('submit').disabled=!current||!!submitFlight;const index=queue.findIndex(i=>i.questionId===current?.questionId);$('prev').disabled=index<0||!queue.slice(0,index).some(i=>i.practiceEligible);$('next').disabled=index<0||!queue.slice(index+1).some(i=>i.practiceEligible);}
let navCollapsed=false,gridCollapsed=false,mobileNav=false,compactGrid=false;
// Measure only when header/status geometry changes, never per question or per scroll.
// Compact overlay panels must follow wrapped headers rather than a hard-coded top.
function updatePanelOffset(){
 const bar=document.querySelector('.topbar'),message=$('status');
 const top=Math.max(bar?.getBoundingClientRect().bottom||0,message?.getBoundingClientRect().bottom||0);
 const maxTop=Math.max(8,window.innerHeight-120);
 document.body.style.setProperty('--practice-panel-top',Math.min(Math.ceil(top+8),maxTop)+'px');
}
const panelObserver=typeof ResizeObserver==='function'?new ResizeObserver(updatePanelOffset):null;
for(const node of [document.querySelector('.topbar'),document.querySelector('.overview'),$('status')])if(node)panelObserver?.observe(node);
window.addEventListener('resize',updatePanelOffset);
window.addEventListener('pagehide',()=>{panelObserver?.disconnect();window.removeEventListener('resize',updatePanelOffset);},{once:true});
updatePanelOffset();
function panels(){const mobile=window.innerWidth<=760,compact=window.innerWidth<=1100;document.body.classList.toggle('nav-hidden',!mobile&&navCollapsed);document.body.classList.toggle('nav-open',mobile&&mobileNav);document.body.classList.toggle('grid-hidden',!compact&&gridCollapsed);document.body.classList.toggle('grid-open',compact&&compactGrid);$('toggle-nav').setAttribute('aria-expanded',String(mobile?mobileNav:!navCollapsed));$('toggle-grid').setAttribute('aria-expanded',String(compact?compactGrid:!gridCollapsed));}
$('toggle-nav').onclick=()=>{if(window.innerWidth<=760)mobileNav=!mobileNav;else navCollapsed=!navCollapsed;panels();};$('close-nav').onclick=()=>{mobileNav=false;navCollapsed=true;panels();};
$('toggle-grid').onclick=()=>{if(window.innerWidth<=1100)compactGrid=!compactGrid;else gridCollapsed=!gridCollapsed;panels();};$('close-grid').onclick=()=>{compactGrid=false;gridCollapsed=true;panels();};window.addEventListener('resize',panels);panels();
$('hide-solution').onclick=()=>{$('solution').hidden=!$('solution').hidden;$('hide-solution').textContent=$('solution').hidden?'展开解析':'收起解析';};
function step(direction){let index=position+direction;while(index>=0&&index<queue.length){if(queue[index].practiceEligible){position=index;return select(queue[index]);}index+=direction;}}
const render=(body,occurrences,signal)=>renderContent(body,occurrences,(o,s)=>bank.image(o,s),signal,urls);
const renderRepair=(body,occurrences,signal,objectUrls)=>renderContent(body,occurrences,(o,s)=>bank.image(o,s),signal,objectUrls);
let mathWarning='';
async function typeset(container){if(!container.querySelector('.math'))return;let timer;try{await Promise.race([(async()=>{if(window.MathJax?.startup?.promise)await window.MathJax.startup.promise;if(window.MathJax?.typesetPromise)await window.MathJax.typesetPromise([container]);})(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('公式排版超时')),5000);})]);}catch(error){mathWarning='公式排版未完成，保留公式原文：'+error.message;console.warn(mathWarning);}finally{clearTimeout(timer);}}
function clear(){loadController?.abort();currentRepair=null;document.getElementById('single-supplement-buttons')?.remove();document.getElementById('single-supplement-panels')?.remove();suiteObserver?.disconnect();suiteMode=false;document.getElementById('exam-controls')?.remove();for(const url of urls)URL.revokeObjectURL(url);urls=[];$('question').replaceChildren();$('solution').replaceChildren();$('solution').hidden=true;$('hide-solution').hidden=true;$('response').replaceChildren();current=null;actions();}
function list(items){queue=items;position=Math.max(0,items.findIndex(i=>i.questionId===current?.questionId));navigation.show(items,{collection:scopeIds.size>0});actions();}
async function select(item){
  clear();const generation=++serial,controller=loadController=new AbortController();selected=[];status('正在校验题目、材料及图片…');
  const q=await bank.question(item,controller.signal),passages=await bank.passages(q,controller.signal),fragment=document.createDocumentFragment();
  const repair=createRepairPanel({client:questionRepairs,question:q,signal:controller.signal,renderBody:renderRepair,typeset,onRefresh:()=>{if(generation===serial){$('solution').hidden=true;$('hide-solution').hidden=true;navigation.result(q.questionId,'requires-self-evaluation');}}});fragment.append(repair.element);
  for(const passage of passages)fragment.append(await render(passage.content,passage.mediaOccurrences,controller.signal));
  fragment.append(await render(q.stem,q.mediaOccurrences.filter(o=>o.zone==='stem'),controller.signal));
  const response=document.createDocumentFragment();
  for(const option of q.options){const label=element('label');label.className='answer-option';const input=element('input');input.type=q.type==='multiple-choice'?'checkbox':'radio';input.name='answer';input.value=option.optionId;input.onchange=()=>{selected=[...$('response').querySelectorAll('input:checked')].map(e=>e.value);};const badge=element('span',option.label);badge.className='answer-label';const content=element('div');content.className='answer-content';content.append(await render(option.content,q.mediaOccurrences.filter(o=>o.zone==='option'),controller.signal));label.append(input,badge,content);response.append(label);}
  if(!q.options.length){const text=element('textarea');text.placeholder='输入思路或答案（此类题目使用自评）';response.append(text);}
  if(generation!==serial||controller.signal.aborted)return;
  $('question-title').textContent=`第 ${item.collectionNumber||position+1} 题`;$('question-type').textContent=typeNames[q.type]||'自评题';$('question').append(fragment);$('response').append(response);
  const supplement=createSupplementControls({client:savedSupplements,question:q,signal:controller.signal});supplement.buttons.id='single-supplement-buttons';supplement.panels.id='single-supplement-panels';$('submit').after(supplement.buttons);$('solution').after(supplement.panels);
  current=q;currentRepair=repair;navigation.select(q.questionId);actions();$('practice').scrollTop=0;mobileNav=false;compactGrid=false;panels();$('practice').focus({preventScroll:true});
  await typeset($('question'));await typeset($('response'));
  let restored=false;
  try{const saved=await readProgress(bank.manifest.bankId,q.questionId,q.revisionDigest);if(generation!==serial)return;if(saved){selected=saved.response.optionIds||[];for(const input of $('response').querySelectorAll('input'))input.checked=selected.includes(input.value);const text=$('response').querySelector('textarea');if(text)text.value=saved.response.text||'';restored=true;navigation.answered(q.questionId);}}catch{/* Private browsing can disable IndexedDB; never prevent reading. */}
  if(generation===serial)status(`固定版本 ${bank.manifest.versionLabel}；题目 ID：${q.questionId}${restored?'；已恢复本浏览器上次作答':''}`);
}
async function submit(){
  if(submitFlight)return submitFlight;
  const task=submitCurrent();submitFlight=task;actions();
  try{return await task;}finally{submitFlight=null;actions();}
}
async function submitCurrent(){
  if(!current)return;const q=current,generation=serial,signal=loadController.signal,optionIds=[...selected],text=$('response').querySelector('textarea')?.value||null,repair=currentRepair,grade=repair.grade(optionIds),result=grade.evaluation,fragment=document.createDocumentFragment();
  fragment.append(element('h3',result==='correct'?'回答正确':result==='incorrect'?'回答有误':'此题需自行核对／自评'));
  appendRepairAnswerNotice(fragment,q,repair.state,grade);
  fragment.append(await render(q.answer.content,q.mediaOccurrences.filter(o=>o.zone==='answer'),signal));
  if(q.answer.optionIds.length)fragment.append(element('p','原库参考选项：'+q.answer.optionIds.map(id=>q.options.find(o=>o.optionId===id)?.label||id).join('、')));
  fragment.append(await render(q.solution,q.mediaOccurrences.filter(o=>o.zone==='solution'),signal));
  if(generation!==serial||grade.version!==repair.version)return;$('solution').replaceChildren(fragment);$('solution').hidden=false;$('hide-solution').hidden=false;$('hide-solution').textContent='收起解析';await typeset($('solution'));if(generation!==serial||grade.version!==repair.version)return;
  try{await saveProgress({id:crypto.randomUUID(),bankId:bank.manifest.bankId,releaseId:bank.manifest.releaseId,questionId:q.questionId,revisionDigest:q.revisionDigest,response:{optionIds,text},evaluation:result,gradingBasis:{mode:grade.mode,repairDigest:grade.repairDigest,referenceOptionIds:grade.referenceOptionIds},submittedAt:Date.now()});if(generation===serial){navigation.answered(q.questionId);status('作答已保存到当前浏览器；答案与解析已揭晓。');}}catch{if(generation===serial)status('答案与解析已显示，但浏览器存储不可用／容量不足，作答未保存。');}
}
// Bounded viewport, not a bank-size limit. Collections follow official order.
async function search(next=false){
  if(suiteMode){clear();serial++;}
  searchController?.abort();searchClient.cancel();
  $('more').disabled=true;
  const controller=searchController=new AbortController(),generation=++searchGeneration;
  if(!scopeIds.size&&!ungroupedScope){clear();list([]);$('more').disabled=true;status('请先选择练习范围，可跨试卷与章节多选。');return;}
  const input={query:'',collectionIds:[...scopeIds],type:'',category:'',limit:scopeIds.size?2000:searchClient.pageSize};
  const key=JSON.stringify(input),offset=next&&key===searchInput?searchOffset+input.limit:0;
  status('正在提取所选范围题目；首次载入需要校验索引，请稍候…');
  const previous=searchFlight;
  const task=(async()=>{await previous.catch(()=>{});if(controller.signal.aborted)return;
    const result=await searchClient.query({...input,offset},controller.signal);
    if(controller.signal.aborted||generation!==searchGeneration)return;
    searchOffset=offset;searchInput=key;list(result.items);$('more').disabled=!result.hasMore;
    status(`匹配 ${result.total} 题；显示 ${result.items.length?offset+1:0}—${offset+result.items.length}。按原卷顺序练习。`);
  })();
  searchFlight=task;return task;
}
for(const [id,fn]of [['submit',submit],['more',()=>search(true)],['prev',async()=>step(-1)],['next',async()=>step(1)]])$(id).onclick=()=>void fn().catch(fail);
$('stop').onclick=()=>{searchController?.abort();searchClient?.cancel();searchGeneration++;if(suiteMode){loadController?.abort();suiteObserver?.disconnect();status('套题加载已停止，当前是未完整加载的套题；题库未修改。');}else status('搜索已停止；题库未修改。');};
function renderCollections(){
  $('collection-options').replaceChildren();
  for(const c of collections.filter(c=>c.kind===collectionTab)){const label=element('label'),input=element('input');input.type='checkbox';input.checked=scopeIds.has(c.collectionId);input.onchange=()=>{input.checked?scopeIds.add(c.collectionId):scopeIds.delete(c.collectionId);renderCollections();};label.append(input,element('span',c.title));$('collection-options').append(label);}
  if(!$('collection-options').children.length)$('collection-options').append(element('p',collectionTab==='paper'?'当前题库没有试卷':'当前题库没有章节'));
  if(!collections.length){const button=element('button','练习未分组题');button.onclick=()=>{ungroupedScope=true;button.textContent='已选未分组题，请应用练习范围';};$('collection-options').append(button);}
  $('scope-count').textContent=`已选 ${[...scopeIds].filter(id=>collections.find(c=>c.collectionId===id)?.kind==='paper').length} 份试卷、${[...scopeIds].filter(id=>collections.find(c=>c.collectionId===id)?.kind==='chapter').length} 个章节`;
  for(const [id,kind] of [['papers-tab','paper'],['chapters-tab','chapter']])$(id).setAttribute('aria-selected',String(collectionTab===kind));$('collection-options').setAttribute('aria-labelledby',collectionTab==='paper'?'papers-tab':'chapters-tab');
}
$('scope-trigger').onclick=()=>{scopeDraft={ids:[...scopeIds],ungrouped:ungroupedScope};$('collection-dialog').showModal();};
function cancelScope(){if(scopeDraft){scopeIds.clear();for(const id of scopeDraft.ids)scopeIds.add(id);ungroupedScope=scopeDraft.ungrouped;scopeDraft=null;renderCollections();}}
$('cancel-collections').onclick=()=>{cancelScope();$('collection-dialog').close();};
$('collection-dialog').addEventListener('cancel',cancelScope);
$('apply-scope').onclick=()=>{scopeDraft=null;$('collection-dialog').close();void search().catch(fail);};
$('select-scope').onclick=()=>{for(const c of collections.filter(c=>c.kind===collectionTab))scopeIds.add(c.collectionId);renderCollections();};
for(const [id,kind] of [['papers-tab','paper'],['chapters-tab','chapter']])$(id).onclick=()=>{collectionTab=kind;renderCollections();};
$('clear-scope').onclick=()=>{scopeIds.clear();ungroupedScope=false;renderCollections();};
$('close-suite').onclick=()=>$('suite-dialog').close();
$('suite').onclick=()=>{$('suite-papers').replaceChildren();for(const c of collections.filter(c=>c.kind==='paper')){const link=element('a',c.title);link.className='button-link';const url=new URL('exam.html',location.href);url.searchParams.set('paper',c.collectionId);link.href=url.href;$('suite-papers').append(link);}$('suite-dialog').showModal();};
async function suite(){
  if(!collections.some(c=>c.collectionId===examPaperId&&c.kind==='paper'))throw Error('仅试卷支持套题练习');
  searchController?.abort();searchClient.cancel();searchGeneration++;
  clear();suiteMode=true;const generation=++serial,controller=loadController=new AbortController();$('suite').disabled=true;
  try{
    const result=await searchClient.query({query:'',collection:examPaperId,type:'',category:'',limit:2000,offset:0},controller.signal);
    if(generation!==serial)return;if(result.hasMore)throw Error('整套题超过2000题展示预算，请拆分集合后练习；未截断展示');
    list(result.items);$('more').disabled=true;$('question-title').textContent='套题练习：'+collections.find(c=>c.collectionId===examPaperId)?.title;$('question-type').textContent='全卷按原题号展开 · 每题独立作答';
    const entries=[],imageJobs=[];
    const controls=element('div');controls.id='exam-controls';controls.className='exam-controls';controls.setAttribute('aria-label','试卷操作');
    const handIn=element('button','提交试卷 / 查看答案'),save=element('button','保存答题进度'),summary=element('span','正在载入全卷…');
    handIn.className='primary';for(const b of [handIn,save])b.disabled=true;controls.append(handIn,save,summary);$('practice').before(controls);
    const session=createExamSession({bankId:bank.manifest.bankId,releaseId:bank.manifest.releaseId,paperId:examPaperId,storage:{getItem:key=>localStorage.getItem(key),setItem:(key,value)=>localStorage.setItem(key,value)}});
    const jobs=new WeakMap();if(typeof IntersectionObserver==='function')suiteObserver=new IntersectionObserver(observed=>{for(const e of observed)if(e.isIntersecting){suiteObserver.unobserve(e.target);void jobs.get(e.target)?.();}},{root:$('practice'),rootMargin:'400px'});
    const deferImage=(img,load)=>{let flight;const once=()=>flight||(flight=Promise.resolve().then(load));jobs.set(img,once);imageJobs.push(once);if(suiteObserver)suiteObserver.observe(img);else void once();};
    const suiteRender=(body,occurrences)=>renderContent(body,occurrences,(o,s)=>bank.image(o,s),controller.signal,urls,{deferImage});
    for(const [index,item]of result.items.entries()){
      if(controller.signal.aborted||generation!==serial)return;
      const card=element('section');card.className='suite-card';card.dataset.questionId=item.questionId;card.append(element('h3',`第 ${item.collectionNumber||index+1} 题 · ${typeNames[item.type]||'自评题'}`));$('question').append(card);
      if(!item.practiceEligible){card.append(element('p','此题已隔离，暂不可练。'));continue;}
      const q=await bank.question(item,controller.signal),materials=await bank.passages(q,controller.signal);
      if(controller.signal.aborted||generation!==serial)return;
      let repair,lastGrade;
      for(const p of materials)card.append(await suiteRender(p.content,p.mediaOccurrences));card.append(await suiteRender(q.stem,q.mediaOccurrences.filter(o=>o.zone==='stem')));
      const inputs=element('div');inputs.className='response';
      for(const o of q.options){const label=element('label');label.className='answer-option';const input=element('input');input.type=q.type==='multiple-choice'?'checkbox':'radio';input.name='suite-'+q.questionId;input.value=o.optionId;label.append(input,element('span',o.label),await suiteRender(o.content,q.mediaOccurrences.filter(x=>x.zone==='option')));inputs.append(label);}
      if(!q.options.length){const input=element('textarea');input.placeholder='输入思路或答案（自评）';inputs.append(input);}
      const button=element('button','查看答案与解析'),answer=element('section'),hideAnswer=element('button','收起原解析');answer.className='solution';answer.hidden=true;hideAnswer.hidden=true;hideAnswer.onclick=()=>{answer.hidden=!answer.hidden;hideAnswer.textContent=answer.hidden?'展开原解析':'收起原解析';};
      repair=createRepairPanel({client:questionRepairs,question:q,signal:controller.signal,renderBody:renderRepair,typeset,onRefresh:()=>{lastGrade=null;answer.hidden=true;hideAnswer.hidden=true;navigation.result(q.questionId,'requires-self-evaluation');summary.textContent='补充校验状态已更新，请重新查看答案以重新统计。';}});card.insertBefore(repair.element,card.children[1]||null);
      const supplement=createSupplementControls({client:savedSupplements,question:q,signal:controller.signal}),questionActions=element('div');questionActions.className='actions';questionActions.append(button,supplement.buttons,hideAnswer);
      const reveal=async(printOnly=false)=>{const optionIds=[...inputs.querySelectorAll('input:checked')].map(x=>x.value),grade=repair.grade(optionIds),evaluation=grade.evaluation;const fragment=document.createDocumentFragment();fragment.append(element('h3',printOnly?'参考答案与解析':evaluation==='correct'?'回答正确':evaluation==='incorrect'?'回答有误':'请自行核对／自评'));appendRepairAnswerNotice(fragment,q,repair.state,grade);fragment.append(await suiteRender(q.answer.content,q.mediaOccurrences.filter(x=>x.zone==='answer')));if(q.answer.optionIds.length)fragment.append(element('p','原库参考选项：'+q.answer.optionIds.map(id=>q.options.find(o=>o.optionId===id)?.label||id).join('、')));fragment.append(await suiteRender(q.solution,q.mediaOccurrences.filter(x=>x.zone==='solution')));if(controller.signal.aborted||generation!==serial)throw Error('cancelled');if(grade.version!==repair.version)throw Error('补充状态已更新，请重新查看答案');answer.replaceChildren(fragment);answer.hidden=false;hideAnswer.hidden=false;hideAnswer.textContent='收起原解析';await typeset(answer);if(controller.signal.aborted||generation!==serial||grade.version!==repair.version)throw Error('补充状态已更新，请重新查看答案');lastGrade=grade;if(!printOnly)navigation.result(q.questionId,evaluation);return evaluation;};
      button.onclick=async()=>{button.disabled=true;try{const evaluation=await reveal();await saveProgress({id:crypto.randomUUID(),bankId:bank.manifest.bankId,releaseId:bank.manifest.releaseId,questionId:q.questionId,revisionDigest:q.revisionDigest,response:{optionIds:[...inputs.querySelectorAll('input:checked')].map(x=>x.value),text:inputs.querySelector('textarea')?.value||null},evaluation,gradingBasis:{mode:lastGrade.mode,repairDigest:lastGrade.repairDigest,referenceOptionIds:lastGrade.referenceOptionIds},submittedAt:Date.now()});}catch(e){fail(e);}finally{button.disabled=false;}};
      entries.push({q,inputs,answer,reveal,repair});
      if(new URL(location.href).pathname.endsWith('/exam.html')){button.hidden=true;button.className='exam-grade';}
      card.append(inputs,questionActions,answer,supplement.panels);
      try{const saved=await readProgress(bank.manifest.bankId,q.questionId,q.revisionDigest);if(saved){for(const input of inputs.querySelectorAll('input'))input.checked=(saved.response.optionIds||[]).includes(input.value);const input=inputs.querySelector('textarea');if(input)input.value=saved.response.text||'';navigation.answered(q.questionId);}}catch{}
      await repair.ready;if(controller.signal.aborted||generation!==serial)return;
      status(`套题加载 ${index+1}/${result.items.length}；图片按滚动位置加载。`);await new Promise(r=>setTimeout(r,0));
    }
    if(generation===serial){
      await typeset($('question'));
      let restored=0,restoreError='';try{restored=session.restore(entries);}catch(e){restoreError=' · 进度恢复失败：'+e.message;}
      for(const b of [handIn,save])b.disabled=false;
      summary.textContent=`全卷 ${result.items.length} 题 · 可练 ${entries.length} 题${restored?' · 已恢复 '+restored+' 题进度':''}${restoreError}`;
      status(`整套已展开 ${result.items.length} 题；目录和题号只跳转位置。请点击上方“保存答题进度”，刷新后自动恢复。${mathWarning}`);
      save.onclick=()=>{try{session.save(entries);summary.textContent='进度已保存到当前浏览器 · '+new Date().toLocaleTimeString();}catch(e){summary.textContent='保存失败：'+e.message;}};
      let busy=false;
      handIn.onclick=async()=>{if(busy)return;busy=true;for(const b of [handIn,save])b.disabled=true;let storageWarning='';try{try{session.save(entries);}catch(e){storageWarning='；浏览器进度保存失败：'+e.message;}for(const input of $('question').querySelectorAll('input,textarea'))input.disabled=true;let correct=0,incorrect=0,self=0;for(const entry of entries){const evaluation=await entry.reveal();if(evaluation==='correct')correct++;else if(evaluation==='incorrect')incorrect++;else self++;}handIn.textContent='重新查看答案';summary.textContent=`正确 ${correct} · 错误／未答 ${incorrect} · 自评 ${self} · 隔离 ${result.items.length-entries.length}${storageWarning}`;status('已交卷，题号导航：✓ 正确、✕ 错误、? 自评；答案与解析位于各题下方。');}catch(e){summary.textContent='交卷未完成：'+e.message;for(const input of $('question').querySelectorAll('input,textarea'))input.disabled=false;}finally{busy=false;for(const b of [handIn,save])b.disabled=false;}};
    }
  }finally{$('suite').disabled=false;}
}
document.addEventListener('keydown',event=>{if(event.repeat||$('collection-dialog').open||$('suite-dialog').open)return;if(event.ctrlKey&&event.key==='Enter'&&current){event.preventDefault();void submit().catch(fail);return;}if(event.ctrlKey||event.metaKey||event.altKey||event.target.closest?.('input,textarea,select,button,a,[contenteditable]'))return;if(current&&['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();void Promise.resolve(step(event.key==='ArrowLeft'?-1:1)).catch(fail);}});
try{
  bank=await openBank(base);$('title').textContent=bank.entry.title.replace('（发布前本地预览）','');document.title=$('title').textContent;$('meta').textContent=`${bank.entry.subject} · ${bank.manifest.versionLabel} · ${bank.manifest.questionCount} 题 · ${bank.entry.authorId} · ${new Date(bank.manifest.publishedAt).toLocaleString()} · ${bank.manifest.changeSummary} · 许可：${bank.entry.license.name}`;
  questionRepairs=createQuestionRepairs(new URL('../supplements/repairs/reader/',location.href),bank);
  savedSupplements=createSavedSupplements(new URL('../supplements/reader/',location.href),{bankId:bank.manifest.bankId,releaseId:bank.manifest.releaseId,manifestHash:bank.entry.currentRelease.manifestHash});
  collections=await bank.collections();
  searchClient=createSearchClient(bank,collections,(done,total)=>status(`正在载入当前题库分类索引 ${done}/${total}…`));
  $('scope-trigger').disabled=false;
  collectionTab=collections.some(c=>c.kind==='paper')?'paper':'chapter';renderCollections();$('suite').hidden=!collections.some(c=>c.kind==='paper');
  const examId=new URL(location.href).searchParams.get('paper');
  if(location.pathname.endsWith('/exam.html')){const paper=collections.find(c=>c.collectionId===examId&&c.kind==='paper');if(!paper)throw Error('所选试卷不存在；章节不能作为套卷');examPaperId=examId;scopeIds.add(examId);document.body.classList.add('exam-mode');$('title').textContent=paper.title;const back=element('a','返回练习');back.href='practice.html';back.className='button-link';document.querySelector('.header-actions').prepend(back);await suite();}else{list([]);$('more').disabled=true;status('已载入题库。请选择试卷或章节，应用练习范围后开始答题。');}
}catch(error){fail(error);for(const b of document.querySelectorAll('button'))if(!['help','close-help','toggle-collections'].includes(b.id))b.disabled=true;}
window.addEventListener('pagehide',()=>{clear();questionRepairs?.dispose();savedSupplements?.dispose();searchController?.abort();searchClient?.dispose();navigation.dispose();window.removeEventListener('resize',panels);});
