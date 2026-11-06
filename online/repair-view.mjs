import {evaluateWithRepairs,missingRequiredMaterial} from './question-repairs.mjs';
import {validateSourceUrl} from './external-materials.mjs';

function element(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
const labels=(question,ids)=>ids.map(id=>question.options.find(o=>o.optionId===id)?.label||id).join('、')||'无客观选项答案';

export function appendRepairAnswerNotice(container,question,state,grade) {
  const box=element('section');box.className='answer-erratum';box.setAttribute('aria-label','判分依据与勘误');
  if(grade.mode==='withheld') {
    box.append(element('h3','本题暂停自动判分'),element('p','必需材料缺失、未完成核验，或补充读取失败。仍可查看原库参考答案，补齐或重试后再核对。'));
  } else if(state?.record?.answerCorrection) {
    box.append(element('h3','按原答案判分'),element('p','本次使用原库参考选项：'+labels(question,question.answer.optionIds)+'。下列补充仅记录核验意见，不改变原答案与判分。'));
  } else if(state?.record?.externalReview) {
    box.append(element('h3','补充材料核验记录'),element('p','题目完整时仍按原库答案判分，补充材料不修改原答案。'));
  } else return;
  const correction=state?.record?.answerCorrection;
  if(correction) {
    box.append(element('p',correction.reason));
    const list=element('ul');for(const evidence of correction.evidence)list.append(element('li',evidence));box.append(list);
    if(state.record.batchId)box.append(element('p','勘误批次：'+state.record.batchId));
  }
  const review=state?.record?.externalReview;
  if(review) {
    box.append(element('h4','补充材料覆盖范围与限制'),element('p',review.coverageReason));
    for(const limitation of review.limitations)box.append(element('p',limitation));
    const evidence=element('ul');for(const check of review.identityChecks)evidence.append(element('li',check));box.append(evidence);
    box.append(element('p','独立核验日期：'+review.reviewedOn));
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
        const record=result.record,externalDimensions=new Map();
        if(record.reviewStatus!=='reviewed')fragment.append(element('p',missingRequiredMaterial(record)||record.materialLinks.length?'本题必需材料尚未完成核验，暂停自动判分。':'补充意见尚未完成复核；题目完整，仍按原库答案判分。'));
        else {
          for(const material of result.materials) {
            const block=element('section');block.className='recovered-material';
            block.append(element('h3','补充材料 · 已核验同卷来源'));
            block.append(element('p',material.link.stemBlockIndexes===null?'显示来源题的完整题干，可能包含来源题提问；不包含其答案与解析。':'以下为来源题干中核实关联的材料部分。'));
            block.append(await renderBody(material.body,material.mediaOccurrences,signal,objectUrls));
            const source=element('details'),summary=element('summary','查看材料来源与关联依据');
            source.append(summary,element('p','试卷：'+material.collectionTitle),element('p','来源题 ID：'+material.link.sourceQuestionId),element('p','来源修订摘要：'+material.link.sourceRevisionDigest),element('p',material.link.evidence));block.append(source);fragment.append(block);
          }
          if(record.answerCorrection?.action==='replace')fragment.append(element('p','本题有补充核验意见。仍按原库答案判分，查看答案时可见客观备注。'));
          if(record.answerCorrection?.action==='withhold')fragment.append(element('p',missingRequiredMaterial(record)?'本题缺少必需材料，暂停自动判分。查看答案时将说明原因。':'本题有答案或解析备注，仍按原库答案判分。查看答案时将说明依据。'));
          if(record.answerCorrection?.action==='keep-original')fragment.append(element('p','本题已有勘误复核记录，结论为保留原答案；查看答案时可见依据。'));
        }
        // External review is independent from the repair/AI status. Reviewed
        // partial material can help the reader, but never clears the grading hold.
        if(record.externalMaterials?.length) {
          const review=record.externalReview;
          if(review?.reviewStatus!=='reviewed')fragment.append(element('p','已找到外部材料，但独立核验尚未完成；暂不展示其正文，本题暂停自动判分。'));
          else {
            for(const material of result.externalMaterials||[]) {
              const block=element('section');block.className='recovered-material external-material';
              block.append(element('h3','补充材料 · '+material.title));
              block.append(element('p',material.kind==='text-summary'?'事实摘要，非逐字原材料。':material.kind==='text-data'?'原表数据转录，重新排版。':'已核验来源图表，本地保存副本。'));
              if(material.kind==='image') {
                const image=element('img');image.alt=material.title;
                const url=URL.createObjectURL(material.blob);objectUrls.push(url);image.src=url;
                externalDimensions.set(image,material.asset);block.append(image);
              } else {const content=element('pre',material.text);content.className='external-material-text';block.append(content);}
              const source=element('details'),summary=element('summary','查看来源与独立核验依据');source.append(summary);
              for(const [label,url] of [['原始页面',material.sourcePageUrl],['原始图表',material.sourceAssetUrl]]) {
                if(!url)continue;const link=element('a',label);link.href=validateSourceUrl(url);link.target='_blank';link.rel='noopener noreferrer';link.referrerPolicy='no-referrer';source.append(link,element('span',' '));
              }
              source.append(element('p','来源核对日期：'+material.checkedOn),element('p',material.identityEvidence),element('p','材料 SHA-256：'+material.contentSha256));
              block.append(source);fragment.append(block);
            }
            if(review.coverage==='partial')fragment.append(element('p','已展示的材料仍不完整，本题继续暂停自动判分。'));
          }
          if(review)fragment.append(element('p','独立核验日期：'+review.reviewedOn+'。详细覆盖范围与限制可在查看答案后阅读，以免提前透露判断思路。'));
        }
        if(signal?.aborted)return;
        // Decode required source images before allowing original-answer grading. A valid
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
          const declared=externalDimensions.get(image);
          if(declared&&(image.naturalWidth!==declared.width||image.naturalHeight!==declared.height))throw Error('external_image_dimensions_mismatch');
          pixels+=image.naturalWidth*image.naturalHeight;
          if(!image.naturalWidth||!image.naturalHeight||image.naturalWidth>8192||image.naturalHeight>8192||pixels>64000000)throw Error('repair_image_decode_failed');
        }
        if(signal?.aborted)return;
        section.replaceChildren(fragment);section.hidden=section.children.length===0;await typeset(section);if(signal?.aborted)return;
        state=result;
      } catch(error) {
        if(signal?.aborted)return;
        releaseImages();state={state:'error'};
        section.replaceChildren(element('p','补充材料或勘误加载失败、版本不匹配或校验未通过。本题暂停自动判分，仍可查看原库参考答案。'));
        const retry=element('button','重试补充材料与勘误');retry.type='button';retry.onclick=()=>void load(true);section.append(retry);
      } finally {if(signal?.aborted)releaseImages();section.removeAttribute('aria-busy');}
    })();flight=task;try{await task;}finally{flight=undefined;}
  }
  const ready=load();
  return {element:section,ready,get state(){return state;},get version(){return version;},grade(ids){return {...evaluateWithRepairs(question,ids,state),version};}};
}
