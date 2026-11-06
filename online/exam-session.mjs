// Browser-only paper session. Official questions/answers remain immutable.
// Scope includes bank + release + paper; a changed revision never receives old input.
export function createExamSession({bankId,releaseId,paperId,storage}){
  const key='km-exam-v1:'+JSON.stringify([bankId,releaseId,paperId]);
  return {
    save(entries){const data={version:1,bankId,releaseId,paperId,savedAt:Date.now(),responses:entries.map(({q,inputs})=>({questionId:q.questionId,revisionDigest:q.revisionDigest,optionIds:[...inputs.querySelectorAll('input:checked')].map(i=>i.value),text:inputs.querySelector('textarea')?.value||''}))};const raw=JSON.stringify(data);if(raw.length>2*1024*1024)throw Error('试卷进度超过保存预算');storage.setItem(key,raw);return data.savedAt;},
    restore(entries){const raw=storage.getItem(key);if(!raw)return 0;if(raw.length>2*1024*1024)throw Error('试卷进度记录过大');const data=JSON.parse(raw);if(data.version!==1||data.bankId!==bankId||data.releaseId!==releaseId||data.paperId!==paperId||!Array.isArray(data.responses)||data.responses.length>2000)throw Error('试卷进度记录无效');const records=new Map();for(const r of data.responses){if(!r||typeof r.questionId!=='string'||records.has(r.questionId)||!Array.isArray(r.optionIds)||r.optionIds.length>100||r.optionIds.some(v=>typeof v!=='string')||typeof r.text!=='string')throw Error('试卷进度记录无效');records.set(r.questionId,r);}let restored=0;for(const {q,inputs}of entries){const r=records.get(q.questionId);if(!r||r.revisionDigest!==q.revisionDigest||r.optionIds.some(id=>!q.options.some(o=>o.optionId===id)))continue;for(const input of inputs.querySelectorAll('input'))input.checked=r.optionIds.includes(input.value);const text=inputs.querySelector('textarea');if(text)text.value=r.text;restored++;}return restored;}
  };
}
