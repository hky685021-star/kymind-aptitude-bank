import {evaluateWithRepairs} from './question-repairs.mjs';

function element(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
const labels=(question,ids)=>ids.map(id=>question.options.find(o=>o.optionId===id)?.label||id).join('、')||'无客观选项答案';

export function appendRepairAnswerNotice(container,question,state,grade) {
  const box=element('section');box.className='answer-erratum';box.setAttribute('aria-label','判分依据与勘误');
  if(grade.mode==='corrected') {
    box.append(element('h3','本次按勘误答案核对'),element('p','勘误后参考选项：'+labels(question,grade.referenceOptionIds)),element('p','原库参考选项：'+labels(question,question.answer.optionIds)+'（原记录保留，不用于本次判分）'));
  } else if(grade.mode==='withheld') {
    box.append(element('h3','本题暂停自动判分'),element('p','仅展示原库参考答案与解析，不能将其视为已核实结论。请先处理补充材料或答案冲突，再重新核对。'));
  } else if(state?.record?.answerCorrection?.action==='keep-original') {
    box.append(element('h3','勘误复核：保留原答案'),element('p','本次使用原库参考选项：'+labels(question,question.answer.optionIds)));
  } else return;
  const correction=state?.record?.answerCorrection;
  if(correction) {
    box.append(element('p',correction.reason));
    const list=element('ul');for(const evidence of correction.evidence)list.append(element('li',evidence));box.append(list);
    if(state.record.batchId)box.append(element('p','勘误批次：'+state.record.batchId));
  }
  box.append(element('p','以下为原库答案与解析，原文未修改。'));container.append(box);
}

export function createRepairPanel({client,question,signal,renderBody,typeset=async()=>{},onRefresh=()=>{}}) {
  const section=element('section');section.className='question-repairs';section.setAttribute('aria-label','补充材料与勘误');
  let state={state:'loading'},version=0,flight;
  const objectUrls=[];
  const releaseImages=()=>{for(const url of objectUrls)URL.revokeObjectURL(url);objectUrls.length=0;};
  signal?.addEventListener('abort',releaseImages,{once:true});
  async function load(refresh=false) {
    if(flight)return flight;
    version++;state={state:'loading'};releaseImages();section.hidden=false;section.setAttribute('aria-busy','true');
    section.replaceChildren(element('p','正在核对补充材料与勘误…'));
    if(refresh){client.refresh();onRefresh();}
    const task=(async()=>{
      try {
        const result=await client.get(question,signal);if(signal?.aborted)return;
        const fragment=document.createDocumentFragment();
        if(result.state==='missing') {state=result;section.replaceChildren();section.hidden=true;return;}
        if(result.state==='stale')throw Error('repair_stale');
        const record=result.record;
        if(record.reviewStatus!=='reviewed')fragment.append(element('p','本题补充尚未完成复核，暂停自动判分。查看答案时会保留原库参考内容并标明限制。'));
        else {
          for(const material of result.materials) {
            const block=element('section');block.className='recovered-material';
            block.append(element('h3','补充材料 · 已核验同卷来源'));
            block.append(element('p',material.link.stemBlockIndexes===null?'显示来源题的完整题干，可能包含来源题提问；不包含其答案与解析。':'以下为来源题干中核实关联的材料部分。'));
            block.append(await renderBody(material.body,material.mediaOccurrences,signal,objectUrls));
            const source=element('details'),summary=element('summary','查看材料来源与关联依据');
            source.append(summary,element('p','试卷：'+material.collectionTitle),element('p','来源题 ID：'+material.link.sourceQuestionId),element('p','来源修订摘要：'+material.link.sourceRevisionDigest),element('p',material.link.evidence));block.append(source);fragment.append(block);
          }
          if(record.answerCorrection?.action==='replace')fragment.append(element('p','原库答案已有经复核勘误。查看答案时将明确列出原答案与修正答案，并按修正答案核对。'));
          if(record.answerCorrection?.action==='withhold')fragment.append(element('p','本题答案或材料仍有争议，暂停自动判分。查看答案时将说明原因。'));
          if(record.answerCorrection?.action==='keep-original')fragment.append(element('p','本题已有勘误复核记录，结论为保留原答案；查看答案时可见依据。'));
        }
        if(signal?.aborted)return;
        // Decode required source images before allowing corrected grading. A valid
        // file hash does not imply that image bytes can actually be displayed.
        const images=[...fragment.querySelectorAll('img')];let pixels=0;
        if(images.length>32)throw Error('repair_image_budget');
        for(const image of images) {
          image.loading='eager';
          if(typeof image.decode!=='function')throw Error('repair_image_decode_unavailable');
          let timer;
          try{await Promise.race([image.decode(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('repair_image_decode_timeout')),10000);})]);}
          finally{clearTimeout(timer);}
          if(signal?.aborted)return;
          pixels+=image.naturalWidth*image.naturalHeight;
          if(!image.naturalWidth||!image.naturalHeight||pixels>64000000)throw Error('repair_image_decode_failed');
        }
        if(signal?.aborted)return;
        section.replaceChildren(fragment);section.hidden=section.children.length===0;await typeset(section);if(signal?.aborted)return;
        state=result;
      } catch(error) {
        if(signal?.aborted||error.name==='AbortError')return;
        releaseImages();state={state:'error'};
        section.replaceChildren(element('p','补充材料或勘误加载失败、版本不匹配或校验未通过。本题暂停自动判分，仍可查看原库参考答案。'));
        const retry=element('button','重试补充材料与勘误');retry.type='button';retry.onclick=()=>void load(true);section.append(retry);
      } finally {section.removeAttribute('aria-busy');}
    })();flight=task;try{await task;}finally{flight=undefined;}
  }
  const ready=load();
  return {element:section,ready,get state(){return state;},get version(){return version;},grade(ids){return {...evaluateWithRepairs(question,ids,state),version};}};
}
