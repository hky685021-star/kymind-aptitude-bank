// DOM-only presentation: public strings are always text, never Markdown/HTML/TeX.
const issueNames = {'missing-image':'缺图片','missing-material':'缺材料','answer-conflict':'答案有冲突','source-unverified':'来源待核验'};
const dimensionNames = {concept:'考点',model:'解题模型',target:'求解目标',context:'题材'};
let nextId = 0;
function element(tag,text) { const node=document.createElement(tag); if(text !== undefined) node.textContent=text; return node; }
function paragraph(section,label,text) { section.append(element('h4',label),element('p',text)); }

export function renderSupplement(section,kind,result) {
  section.replaceChildren();
  const content = result[kind];
  if (result.state === 'stale') {
    section.append(element('p','保存的补充与当前题库版本或题目摘要不一致，未展示旧内容。请刷新补充索引后重试。')); return;
  }
  if (result.state === 'missing' || !content) {
    section.append(element('p',kind === 'ai' ? '本题尚未保存 AI 解析。' : '本题尚未保存模型索引。')); return;
  }
  const note = element('p'); note.className = 'supplement-note';
  if (kind === 'ai') {
    note.textContent = ({reviewed:'已复核的保存稿，仍请结合原题核对。', 'needs-review':'待复核稿，不能视为已确认答案。', blocked:'已阻断：材料或来源问题尚未解决，不作为解题结论。'})[content.reviewStatus];
    section.append(note);
    paragraph(section,'重点解析',content.focusAnalysis);
    paragraph(section,'秒杀技巧',content.quickTip);
    if(content.sourceIssues.length) paragraph(section,'原题问题',content.sourceIssues.map(issue=>issueNames[issue]).join('、'));
  } else {
    note.textContent = ({pending:'候选模型索引，尚待审核；空项表示暂无准确映射。',reviewed:'已复核的模型映射；词条自身的状态另列。',quarantined:'模型索引已隔离，不能用于训练筛选。'})[content.reviewStatus];
    section.append(note);
    paragraph(section,'知识分类',content.knowledgeCategory);
    for (const [dimension,label] of Object.entries(dimensionNames)) {
      section.append(element('h4',label));
      const terms=content.dimensions[dimension];
      if(!terms.length) section.append(element('p','暂无准确映射'));
      for(const term of terms) {
        const detail=element('details'), summary=element('summary',`${term.label} · ${term.reviewStatus === 'pending' ? '待审核词条' : '已复核词条'}`);
        detail.append(summary,element('p',term.definition),element('p','代码：'+term.code)); section.append(detail);
      }
    }
    paragraph(section,'映射依据',content.basis);
    if(content.pendingReasons.length) {
      section.append(element('h4','待复核事项')); const list=element('ul');
      for(const reason of content.pendingReasons) list.append(element('li',reason)); section.append(list);
    }
  }
  const source=element('p','保存批次：'+content.batchId+'。此补充独立于原题签名数据，网页不会实时生成。');
  source.className='supplement-source'; section.append(source);
}

export function createSupplementControls({client,question,signal}) {
  const buttons=element('span'), panels=element('div'); buttons.className='supplement-buttons';
  for (const [kind,label] of [['ai','AI解析'],['models','模型索引']]) {
    const button=element('button',label), section=element('section');
    button.type='button'; section.className='saved-supplement'; section.hidden=true;
    section.id='saved-supplement-'+(++nextId); section.setAttribute('aria-label',label); section.setAttribute('aria-live','polite');
    button.setAttribute('aria-controls',section.id); button.setAttribute('aria-expanded','false');
    let loaded=false,flight;
    async function load(refresh=false) {
      if(flight) return flight;
      if(refresh) client.refresh();
      section.replaceChildren(element('p','正在读取已保存的'+label+'…')); section.setAttribute('aria-busy','true');
      const task=(async()=>{
        try {
          const result=await client.get(question,signal);
          if(signal?.aborted) return;
          renderSupplement(section,kind,result); loaded=true;
          if(result.state !== 'ready' || !result[kind]) {
            const retry=element('button','刷新补充索引'); retry.type='button'; retry.onclick=()=>void load(true); section.append(retry);
          }
        } catch(error) {
          if(signal?.aborted || error.name==='AbortError') return;
          // 404/HTTP/parse/hash failures are not an assertion that no saved record exists.
          section.replaceChildren(element('p','补充加载失败或校验未通过，未展示内容。原答案与解析仍可独立查看。'));
          const retry=element('button','重试加载'); retry.type='button'; retry.onclick=()=>void load(true); section.append(retry); loaded=false;
        } finally { section.removeAttribute('aria-busy'); }
      })();
      flight=task; try { await task; } finally { flight=undefined; }
    }
    button.onclick=()=>{
      section.hidden=!section.hidden; button.setAttribute('aria-expanded',String(!section.hidden));
      button.textContent=section.hidden?label:'收起'+label;
      if(!section.hidden&&!loaded) void load();
    };
    buttons.append(button); panels.append(section);
  }
  return {buttons,panels};
}
