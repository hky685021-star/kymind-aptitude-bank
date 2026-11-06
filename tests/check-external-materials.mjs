// Real-data runtime integration. Reads a candidate folder; does not publish or modify it.
// node tests/check-external-materials.mjs /path/to/aptitude-batch-0001
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonical,hash,openBank} from '../online/core.mjs';
import {createQuestionRepairs,evaluateWithRepairs} from '../online/question-repairs.mjs';
const input=process.argv[2];if(!input)throw Error('Provide candidate work folder');
const work=pathToFileURL(resolve(input)+'/'),enc=new TextEncoder();
const json=async name=>JSON.parse(await readFile(new URL(name,work),'utf8'));
const jsonl=async name=>(await readFile(new URL(name,work),'utf8')).trim().split('\n').map(JSON.parse);
const rows=await jsonl('external-recovery/materials-to-publish.jsonl'),reviews=await jsonl('external-recovery/external-material-reviews.jsonl');
const assets=await json('external-recovery/material-assets-to-copy.json');
const reviewById=new Map(reviews.map(r=>[r.key.questionId,r]));assert.equal(reviewById.size,reviews.length);
const bankLocal=new URL('../original/bank-civil-aptitude/',import.meta.url),bankRemote=new URL('https://reader.test/bank/'),readerRemote=new URL('https://reader.test/supplements/repairs/reader/');
const sourceFetch=globalThis.fetch,served=new Map(),requests=[];
for(const row of assets){const bytes=await readFile(new URL(row.sourcePath,work));assert.equal(bytes.length,row.asset.byteLength);assert.equal(await hash(bytes),row.asset.sha256);served.set('/supplements/repairs/'+row.asset.path,bytes);}
globalThis.fetch=async(url,options)=>{
  url=new URL(url);requests.push(url.pathname);assert.equal(url.origin,bankRemote.origin);assert.equal(options.redirect,'error');
  if(url.pathname.startsWith(bankRemote.pathname))return new Response(await readFile(new URL(url.pathname.slice(bankRemote.pathname.length),bankLocal)));
  assert.ok(served.has(url.pathname),'Undeclared local fetch: '+url.pathname);return new Response(served.get(url.pathname));
};
let client;
try {
  const bank=await openBank(bankRemote),scope={bankId:bank.manifest.bankId,releaseId:bank.manifest.releaseId,manifestHash:bank.entry.currentRelease.manifestHash};
  const records=rows.map(row=>({schemaVersion:1,key:row.key,batchId:'candidate-runtime-check',reviewStatus:'blocked',materialLinks:[],answerCorrection:null,sourceIssues:['missing-material'],externalMaterials:row.externalMaterials,externalReview:reviewById.get(row.key.questionId)||null}));
  const groups=new Map();for(const record of records){const prefix=record.key.questionId.slice(2,4);if(!groups.has(prefix))groups.set(prefix,[]);groups.get(prefix).push(record);}
  const shards=[];for(const [prefix,items] of groups){const bytes=enc.encode(canonical({schemaVersion:1,...scope,prefix,records:items})),sha256=await hash(bytes),path=`v1/${prefix}-${sha256}.json`;shards.push({prefix,path,sha256,byteLength:bytes.length,recordCount:items.length});served.set(readerRemote.pathname+path,bytes);}
  served.set(readerRemote.pathname+'index.json',JSON.stringify({schemaVersion:1,...scope,recordCount:records.length,shards:shards.sort((a,b)=>a.prefix.localeCompare(b.prefix))}));
  client=createQuestionRepairs(readerRemote,bank);
  const wanted=new Set(rows.map(r=>r.key.questionId)),items=new Map();
  for(let page=0;page<bank.root.pages.length&&items.size<wanted.size;page++)for(const item of await bank.page(page))if(wanted.has(item.questionId))items.set(item.questionId,item);
  let images=0,texts=0,originalGraded=0;const held=[];
  for(const row of rows) {
    const q=await bank.question(items.get(row.key.questionId)),before=JSON.stringify(q),state=await client.get(q);
    assert.equal(state.state,'ready');assert.deepEqual(state.record.key,row.key);
    const review=state.record.externalReview,expected=review?.reviewStatus==='reviewed'?row.externalMaterials.length:0;
    assert.equal(state.externalMaterials.length,expected);
    for(const material of state.externalMaterials) {
      if(material.kind==='image'){assert.equal(await hash(new Uint8Array(await material.blob.arrayBuffer())),material.contentSha256);images++;}
      else {assert.equal(await hash(enc.encode(material.text)),material.contentSha256);texts++;}
    }
    const grade=evaluateWithRepairs(q,q.answer.optionIds,state);
    if(review?.reviewStatus==='reviewed'&&review.coverage==='sufficient'){assert.equal(grade.mode,'original');assert.equal(grade.evaluation,'correct');originalGraded++;}
    else{assert.equal(grade.mode,'withheld');held.push(row.sequence);}
    assert.equal(JSON.stringify(q),before);
  }
  console.log(JSON.stringify({passed:true,records:rows.length,materials:images+texts,images,texts,originalGraded,held,originalsUnchanged:true,onlyLocalRequests:true,requests:requests.length,browserDecodeVerified:false}));
}finally{client?.dispose();globalThis.fetch=sourceFetch;}
