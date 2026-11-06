// Optional real-data integration: node tests/check-repair-examples.mjs /path/to/records.jsonl
// The input is validated against the preserved bank; no data or files are changed.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {openBank} from '../online/core.mjs';
import {validateRepairRecord,resolveRepairMaterials,validateCorrectionForQuestion,evaluateWithRepairs} from '../online/question-repairs.mjs';

const input=process.argv[2];if(!input)throw Error('Provide a repair records JSONL path');
const examples=(await readFile(input,'utf8')).trim().split('\n').map(JSON.parse);
const base=new URL('../original/bank-civil-aptitude/',import.meta.url),remote=new URL('https://reader.test/bank/');
const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
  url=new URL(url);assert.equal(url.origin,remote.origin);assert.ok(url.pathname.startsWith(remote.pathname));assert.equal(options.redirect,'error');
  return new Response(await readFile(new URL(url.pathname.slice(remote.pathname.length),base)));
};
try {
  const bank=await openBank(remote),scope={bankId:bank.manifest.bankId,releaseId:bank.manifest.releaseId,manifestHash:bank.entry.currentRelease.manifestHash};
  const wanted=new Set(examples.map(r=>r.key.questionId)),items=new Map();
  for(let i=0;i<bank.root.pages.length&&items.size<wanted.size;i++)for(const item of await bank.page(i))if(wanted.has(item.questionId))items.set(item.questionId,item);
  let materials=0,images=0,holds=0;
  for(const record of examples) {
    validateRepairRecord(record,scope);const q=await bank.question(items.get(record.key.questionId)),before=JSON.stringify(q);
    validateCorrectionForQuestion(record,q);
    const resolved=record.reviewStatus==='reviewed'?await resolveRepairMaterials(bank,q,record):[];
    for(const material of resolved){materials++;for(const occurrence of material.mediaOccurrences){const blob=await bank.image(occurrence);assert.ok(blob.size>0);images++;}}
    const grade=evaluateWithRepairs(q,q.answer.optionIds,{state:'ready',record,materials:resolved,repairDigest:null});
    if(record.answerCorrection?.action==='withhold'){assert.equal(grade.mode,'withheld');holds++;}
    assert.equal(JSON.stringify(q),before);
  }
  console.log(JSON.stringify({passed:true,records:examples.length,materials,images,withheld:holds,originalsUnchanged:true}));
} finally {globalThis.fetch=originalFetch;}
