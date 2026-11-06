// Controlled, source-bound materials and answer errata. Original questions stay immutable.
import {boundedFetch,canonical,evaluate,hash} from './core.mjs';
import {validateIndex} from './saved-supplements.mjs';

const dec=new TextDecoder('utf-8',{fatal:true}), enc=new TextEncoder();
const HEX=/^[a-f0-9]{64}$/, QID=/^q_[a-f0-9]{64}$/;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const text=(v,max=16000)=>typeof v==='string'&&v.trim().length>0&&v.length<=max;
const require=(ok,reason='repair_invalid')=>{if(!ok)throw Error(reason);};
const strings=(v,max=32,length=2000)=>Array.isArray(v)&&v.length<=max&&v.every(x=>text(x,length));
const scopeMatches=(a,b)=>['bankId','releaseId','manifestHash'].every(k=>a[k]===b[k]);
const sameSet=(a,b)=>a.length===b.length&&new Set(a).size===a.length&&a.every(x=>b.includes(x));

export function validateRepairRecord(row,scope) {
  require(object(row)&&row.schemaVersion===1&&object(row.key)&&scopeMatches(row.key,scope));
  require(QID.test(row.key.questionId)&&HEX.test(row.key.revisionDigest));
  require(['reviewed','needs-review','blocked'].includes(row.reviewStatus));
  require(Array.isArray(row.materialLinks)&&row.materialLinks.length<=8);
  const links=new Set();
  for(const link of row.materialLinks) {
    require(object(link)&&QID.test(link.sourceQuestionId)&&HEX.test(link.sourceRevisionDigest));
    require(link.sourceQuestionId!==row.key.questionId&&text(link.collectionId,200)&&text(link.evidence));
    require(/^questions\/[a-zA-Z0-9._-]+\.jsonl$/.test(link.sourceFile));
    const indexes=link.stemBlockIndexes;
    require(indexes===null||(Array.isArray(indexes)&&indexes.length>0&&indexes.length<=128&&indexes.every((n,i)=>Number.isSafeInteger(n)&&n>=0&&(i===0||n>indexes[i-1]))));
    const identity=JSON.stringify([link.sourceQuestionId,indexes]);require(!links.has(identity));links.add(identity);
  }
  const correction=row.answerCorrection;
  require(correction===null||object(correction));
  if(correction) {
    require(['replace','withhold','keep-original'].includes(correction.action));
    for(const ids of [correction.originalOptionIds,correction.correctedOptionIds])require(strings(ids,100,100)&&new Set(ids).size===ids.length);
    require(text(correction.reason)&&strings(correction.evidence)&&correction.evidence.length>0);
    if(correction.action==='replace')require(row.reviewStatus==='reviewed'&&correction.correctedOptionIds.length>0);
    else require(correction.correctedOptionIds.length===0);
    if(correction.action==='keep-original')require(row.reviewStatus==='reviewed');
  }
  return row;
}

export function validateCorrectionForQuestion(record,question) {
  require(record.key.questionId===question.questionId&&record.key.revisionDigest===question.revisionDigest&&record.key.bankId===question.bankId,'repair_question_mismatch');
  const correction=record.answerCorrection;
  if(!correction)return;
  require(sameSet(correction.originalOptionIds,question.answer.optionIds),'repair_original_answer_mismatch');
  require(correction.originalOptionIds.every(id=>question.options.some(o=>o.optionId===id)),'repair_original_option_invalid');
  if(correction.action==='replace') {
    require(question.answer.grading==='objective'&&['single-choice','multiple-choice','true-false'].includes(question.type),'repair_grading_unsupported');
    require(correction.correctedOptionIds.every(id=>question.options.some(o=>o.optionId===id)),'repair_corrected_option_invalid');
    require(question.type==='multiple-choice'||correction.correctedOptionIds.length===1,'repair_answer_cardinality');
    require(!sameSet(correction.correctedOptionIds,question.answer.optionIds),'repair_answer_unchanged');
  }
}

export function validateRepairShard(value,index,ref) {
  require(object(value)&&value.schemaVersion===1&&scopeMatches(value,index)&&value.prefix===ref.prefix);
  require(Array.isArray(value.records)&&value.records.length===ref.recordCount);
  const records=new Map();
  for(const row of value.records) {
    validateRepairRecord(row,index);
    require(row.key.questionId.slice(2,4)===ref.prefix&&!records.has(row.key.questionId));
    records.set(row.key.questionId,row);
  }
  return records;
}

export function selectMaterialBody(source,link,manifest) {
  require(source.stem?.format==='tiptap-portable-v1'&&source.stem.doc?.type==='doc'&&Array.isArray(source.stem.doc.content),'repair_stem_invalid');
  const blocks=link.stemBlockIndexes===null?source.stem.doc.content:link.stemBlockIndexes.map(i=>{
    require(i<source.stem.doc.content.length,'repair_block_missing');return source.stem.doc.content[i];
  });
  const selectedIds=new Set(),stack=blocks.map(node=>({node,depth:0}));let count=0,characters=0;
  while(stack.length) {
    const {node,depth}=stack.pop();require(object(node)&&++count<=20000&&depth<=64,'repair_material_budget');
    if(node.type==='text'){require(typeof node.text==='string');characters+=node.text.length;require(characters<=200000,'repair_material_budget');}
    if(node.type==='questionImage'){require(text(node.attrs?.occurrenceId,200)&&!selectedIds.has(node.attrs.occurrenceId),'repair_duplicate_or_invalid_image');selectedIds.add(node.attrs.occurrenceId);}
    if(node.content!==undefined){require(Array.isArray(node.content));for(const child of node.content)stack.push({node:child,depth:depth+1});}
  }
  require(selectedIds.size<=32,'repair_image_budget');
  const occurrences=[];let totalBytes=0;
  for(const id of selectedIds) {
    const matches=source.mediaOccurrences.filter(o=>o.occurrenceId===id&&o.zone==='stem');
    require(matches.length===1&&matches[0].status==='ready','repair_media_missing');
    const occurrence=matches[0],media=manifest.media.find(m=>m.mediaId===occurrence.mediaId);
    require(media&&['image/png','image/jpeg','image/bmp'].includes(media.mimeType),'repair_media_missing');
    totalBytes+=media.byteLength;require(totalBytes<=16*1024*1024,'repair_image_budget');occurrences.push(occurrence);
  }
  return {body:{format:'tiptap-portable-v1',doc:{type:'doc',content:blocks}},mediaOccurrences:occurrences,imageBytes:totalBytes};
}

export async function resolveRepairMaterials(bank,question,record,signal) {
  if(!record.materialLinks.length)return [];
  require(record.reviewStatus==='reviewed','repair_material_not_reviewed');
  const collections=await bank.collections(signal),materials=[];
  let imageBytes=0,imageCount=0;
  for(const link of record.materialLinks) {
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    const collection=collections.find(c=>c.collectionId===link.collectionId);
    require(collection?.bankId===question.bankId&&collection.kind==='paper','repair_collection_invalid');
    for(const id of [question.questionId,link.sourceQuestionId])require(collection.orderedQuestionRefs.some(r=>r.bankId===question.bankId&&r.questionId===id),'repair_collection_membership');
    require(bank.manifest.files.some(f=>f.path===link.sourceFile&&f.kind==='question'),'repair_source_file_invalid');
    // bank.records verifies the exact manifest-declared file length and SHA256.
    const matches=(await bank.records(link.sourceFile,signal)).filter(q=>q.questionId===link.sourceQuestionId);
    require(matches.length===1,'repair_source_missing');const source=matches[0];
    require(source.bankId===question.bankId&&source.revisionDigest===link.sourceRevisionDigest,'repair_source_revision_mismatch');
    const revision={...source};delete revision.revisionDigest;
    require(await hash(enc.encode(canonical(revision)))===link.sourceRevisionDigest,'repair_source_revision_mismatch');
    require(source.review?.practiceEligible===true&&source.review?.status!=='quarantined','repair_source_quarantined');
    const selected=selectMaterialBody(source,link,bank.manifest);
    imageBytes+=selected.imageBytes;imageCount+=selected.mediaOccurrences.length;
    require(imageBytes<=16*1024*1024&&imageCount<=32,'repair_image_budget');
    materials.push({...selected,link,collectionTitle:collection.title});
  }
  return materials;
}

export function createQuestionRepairs(base,bank) {
  const scope={bankId:bank.manifest.bankId,releaseId:bank.manifest.releaseId,manifestHash:bank.entry.currentRelease.manifestHash};
  const controller=new AbortController(),cache=new Map(),flights=new Map();let indexFlight;
  // Retain a failed directory read until explicit retry, so a full paper does not
  // hammer a failed endpoint once per question. Never turn that failure into absence.
  const index=()=>indexFlight ||= boundedFetch(new URL('index.json',base),256*1024,controller.signal).then(b=>validateIndex(JSON.parse(dec.decode(b))));
  async function page(catalog,ref) {
    if(cache.has(ref.sha256))return cache.get(ref.sha256);
    if(flights.has(ref.sha256))return flights.get(ref.sha256);
    require(flights.size<4,'repair_busy');
    const flight=(async()=>{
      const bytes=await boundedFetch(new URL(ref.path,base),ref.byteLength,controller.signal);
      require(bytes.length===ref.byteLength&&await hash(bytes)===ref.sha256,'repair_hash_mismatch');
      const records=validateRepairShard(JSON.parse(dec.decode(bytes)),catalog,ref);cache.set(ref.sha256,records);
      while(cache.size>4)cache.delete(cache.keys().next().value);return records;
    })();flights.set(ref.sha256,flight);
    try{return await flight;}finally{flights.delete(ref.sha256);}
  }
  return {
    async get(question,signal) {
      if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      require(question.bankId===scope.bankId&&QID.test(question.questionId)&&HEX.test(question.revisionDigest));
      const catalog=await index();if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      if(!scopeMatches(catalog,scope))return {state:'stale'};
      const ref=catalog.shards.find(s=>s.prefix===question.questionId.slice(2,4));if(!ref)return {state:'missing'};
      const record=(await page(catalog,ref)).get(question.questionId);if(!record)return {state:'missing'};
      if(record.key.revisionDigest!==question.revisionDigest)return {state:'stale'};
      validateCorrectionForQuestion(record,question);
      // Unreviewed records remain visible as a hold, but never fetch/display unreviewed material.
      const materials=record.reviewStatus==='reviewed'?await resolveRepairMaterials(bank,question,record,signal):[];
      if(signal?.aborted)throw new DOMException('Aborted','AbortError');
      return {state:'ready',record,materials,repairDigest:await hash(enc.encode(canonical(record)))};
    },
    refresh(){indexFlight=undefined;cache.clear();},
    dispose(){controller.abort();cache.clear();flights.clear();}
  };
}

export function evaluateWithRepairs(question,optionIds,state) {
  // Validate the response even when grading is withheld.
  const original=evaluate(question,optionIds);
  const withheld={evaluation:'requires-self-evaluation',mode:'withheld',referenceOptionIds:[],repairDigest:state?.repairDigest||null};
  if(state?.state==='missing')return {evaluation:original,mode:'original',referenceOptionIds:[...question.answer.optionIds],repairDigest:null};
  if(state?.state!=='ready'||state.record.reviewStatus!=='reviewed')return withheld;
  validateCorrectionForQuestion(state.record,question);
  const correction=state.record.answerCorrection;
  if(correction?.action==='withhold')return withheld;
  if(correction?.action==='replace') {
    const ids=[...correction.correctedOptionIds];
    return {evaluation:evaluate({...question,answer:{...question.answer,optionIds:ids}},optionIds),mode:'corrected',referenceOptionIds:ids,repairDigest:state.repairDigest};
  }
  return {evaluation:original,mode:'original',referenceOptionIds:[...question.answer.optionIds],repairDigest:state.repairDigest};
}
