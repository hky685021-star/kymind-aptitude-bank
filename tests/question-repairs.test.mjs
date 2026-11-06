import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {canonical,hash} from '../online/core.mjs';
import {validateIndex} from '../online/saved-supplements.mjs';
import {createQuestionRepairs,evaluateWithRepairs,resolveRepairMaterials,selectMaterialBody,validateCorrectionForQuestion,validateRepairRecord,validateRepairShard} from '../online/question-repairs.mjs';

const enc=new TextEncoder(),clone=structuredClone;
const scope={bankId:'bank-test',releaseId:'release-test',manifestHash:'a'.repeat(64)};
const paragraph=text=>({type:'paragraph',content:[{type:'text',text}]});
const portable=content=>({format:'tiptap-portable-v1',doc:{type:'doc',content}});
const target={bankId:scope.bankId,questionId:'q_00'+'1'.repeat(62),revisionDigest:'b'.repeat(64),type:'single-choice',answer:{grading:'objective',optionIds:['option_b']},options:[{optionId:'option_a',label:'A'},{optionId:'option_b',label:'B'}]};
const source={bankId:scope.bankId,questionId:'q_01'+'2'.repeat(62),type:'single-choice',stem:portable([paragraph('经核实的材料'),paragraph('来源题的提问')]),answer:{content:portable([paragraph('不应该泄露的来源答案')])},review:{practiceEligible:true,status:'ready'},mediaOccurrences:[]};
source.revisionDigest=await hash(enc.encode(canonical(source)));
const link={sourceQuestionId:source.questionId,sourceRevisionDigest:source.revisionDigest,sourceFile:'questions/part-000001.jsonl',collectionId:'collection-test',evidence:'同卷材料明确适用于目标题号',stemBlockIndexes:[0]};
const record={schemaVersion:1,key:{...scope,questionId:target.questionId,revisionDigest:target.revisionDigest},batchId:'test',reviewStatus:'reviewed',materialLinks:[link],answerCorrection:{action:'replace',originalOptionIds:['option_b'],correctedOptionIds:['option_a'],reason:'独立计算证明原答案有误',evidence:['完整条件推导得到A']}};
function bank(overrides={}) {
  return {manifest:{...scope,files:[{path:link.sourceFile,kind:'question'}],media:[]},entry:{currentRelease:{manifestHash:scope.manifestHash}},
    async collections(){return [{collectionId:link.collectionId,bankId:scope.bankId,kind:'paper',title:'同卷',orderedQuestionRefs:[target,source].map(q=>({bankId:q.bankId,questionId:q.questionId}))}];},
    async records(name){assert.equal(name,link.sourceFile);return [clone(source)];},...overrides};
}
const ready=(r=record)=>({state:'ready',record:r,materials:[],repairDigest:'c'.repeat(64)});

test('verified historical correction remains annotation; complete questions retain original grading',()=>{
  const before=JSON.stringify(target);validateRepairRecord(record,scope);validateCorrectionForQuestion(record,target);
  const grade=evaluateWithRepairs(target,['option_a'],ready());
  assert.equal(grade.evaluation,'incorrect');assert.equal(grade.mode,'original');assert.deepEqual(grade.referenceOptionIds,['option_b']);
  assert.equal(evaluateWithRepairs(target,['option_b'],ready()).evaluation,'correct');assert.equal(JSON.stringify(target),before);
});

test('missing repair index entry uses original, but loading/error/stale or unreviewed state never guesses',()=>{
  assert.equal(evaluateWithRepairs(target,['option_b'],{state:'missing'}).evaluation,'correct');
  for(const state of [{state:'loading'},{state:'error'},{state:'stale'},null,ready({...record,reviewStatus:'needs-review'})])
    assert.equal(evaluateWithRepairs(target,['option_b'],state).mode,'withheld');
  assert.throws(()=>evaluateWithRepairs(target,['unknown'],{state:'error'}),/response_invalid/);
});

test('complete disputed questions keep original grading; missing material alone withholds',()=>{
  for(const reviewStatus of ['reviewed','needs-review','blocked']) {
    const r={...record,reviewStatus,materialLinks:[],sourceIssues:['answer-conflict','source-unverified'],answerCorrection:{...record.answerCorrection,action:'withhold',correctedOptionIds:[]}};
    validateRepairRecord(r,scope);assert.equal(evaluateWithRepairs(target,['option_b'],ready(r)).mode,'original');
    assert.equal(evaluateWithRepairs(target,['option_b'],ready({...r,sourceIssues:['missing-material']})).mode,'withheld');
    assert.equal(evaluateWithRepairs(target,['option_b'],ready({...r,sourceIssues:['missing-image']})).mode,'withheld');
  }
  const keep={...record,answerCorrection:{...record.answerCorrection,action:'keep-original',correctedOptionIds:[]}};
  validateRepairRecord(keep,scope);assert.equal(evaluateWithRepairs(target,['option_b'],ready(keep)).evaluation,'correct');
});

test('stale or misleading corrections, invented options and invalid cardinality are rejected',()=>{
  for(const mutate of [
    r=>{r.key.revisionDigest='d'.repeat(64);},r=>{r.answerCorrection.originalOptionIds=['option_a'];},
    r=>{r.answerCorrection.correctedOptionIds=['option_x'];},r=>{r.answerCorrection.correctedOptionIds=['option_a','option_b'];},
    r=>{r.answerCorrection.correctedOptionIds=['option_b'];}
  ]) {const r=clone(record);mutate(r);assert.throws(()=>validateCorrectionForQuestion(r,target));}
  for(const mutate of [r=>{r.reviewStatus='needs-review';},r=>{r.answerCorrection.evidence=[];},r=>{r.answerCorrection.correctedOptionIds=['option_a','option_a'];}]) {
    const r=clone(record);mutate(r);assert.throws(()=>validateRepairRecord(r,scope));
  }
});

test('only selected signed stem blocks become materials; full stem is explicit and source answer never copied',async()=>{
  const materials=await resolveRepairMaterials(bank(),target,record);
  assert.equal(materials.length,1);assert.equal(materials[0].body.doc.content.length,1);
  assert.match(JSON.stringify(materials[0].body),/经核实的材料/);assert.doesNotMatch(JSON.stringify(materials[0].body),/来源题的提问|不应该泄露/);
  const full=selectMaterialBody(source,{...link,stemBlockIndexes:null},bank().manifest);
  assert.equal(full.body.doc.content.length,2);assert.doesNotMatch(JSON.stringify(full.body),/不应该泄露/);
  assert.throws(()=>selectMaterialBody(source,{...link,stemBlockIndexes:[2]},bank().manifest),/repair_block_missing/);
});

test('materials require same signed paper membership, declared question file and exact source revision',async()=>{
  await assert.rejects(resolveRepairMaterials(bank({async collections(){return [];}}),target,record),/repair_collection_invalid/);
  const wrong=bank();wrong.collections=async()=>[{collectionId:link.collectionId,bankId:scope.bankId,kind:'paper',orderedQuestionRefs:[{bankId:scope.bankId,questionId:target.questionId}]}];
  await assert.rejects(resolveRepairMaterials(wrong,target,record),/repair_collection_membership/);
  const missing=bank();missing.manifest.files=[];await assert.rejects(resolveRepairMaterials(missing,target,record),/repair_source_file_invalid/);
  const tampered=bank({async records(){return [{...source,stem:portable([paragraph('篡改材料')])}];}});
  await assert.rejects(resolveRepairMaterials(tampered,target,record),/repair_source_revision_mismatch/);
  const stale=clone(record);stale.materialLinks[0].sourceRevisionDigest='d'.repeat(64);
  await assert.rejects(resolveRepairMaterials(bank(),target,stale),/repair_source_revision_mismatch/);
  const unreviewed={...record,reviewStatus:'needs-review'};await assert.rejects(resolveRepairMaterials(bank(),target,unreviewed),/repair_material_not_reviewed/);
});

test('material images are stem-scoped ready occurrences of declared safe media with size limits',()=>{
  const imageSource={...source,stem:portable([{type:'questionImage',attrs:{occurrenceId:'occ-1'}}]),mediaOccurrences:[{zone:'stem',occurrenceId:'occ-1',status:'ready',mediaId:'media-test'}]};
  const manifest={media:[{mediaId:'media-test',mimeType:'image/png',byteLength:100}]};
  assert.equal(selectMaterialBody(imageSource,link,manifest).imageBytes,100);
  assert.throws(()=>selectMaterialBody({...imageSource,stem:portable([imageSource.stem.doc.content[0],imageSource.stem.doc.content[0]])},{...link,stemBlockIndexes:null},manifest),/repair_duplicate_or_invalid_image/);
  for(const [q,m] of [
    [{...imageSource,mediaOccurrences:[{...imageSource.mediaOccurrences[0],zone:'answer'}]},manifest],
    [{...imageSource,mediaOccurrences:[{...imageSource.mediaOccurrences[0],status:'missing'}]},manifest],
    [imageSource,{media:[{...manifest.media[0],mimeType:'image/svg+xml'}]}],
    [imageSource,{media:[{...manifest.media[0],byteLength:16*1024*1024+1}]}]
  ])assert.throws(()=>selectMaterialBody(q,link,m));
});

async function fixture(run,{indexMutation,shardMutation,fail}={}) {
  const shard={schemaVersion:1,...scope,prefix:'00',records:[clone(record)]};if(shardMutation)shardMutation(shard);
  const bytes=enc.encode(JSON.stringify(shard)),sha256=await hash(bytes);
  const index={schemaVersion:1,...scope,recordCount:1,shards:[{prefix:'00',path:`v1/00-${sha256}.json`,sha256,byteLength:bytes.length,recordCount:1}]};if(indexMutation)indexMutation(index);
  const old=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,options)=>{url=new URL(url);requests.push(url.pathname);assert.equal(url.origin,'https://reader.test');assert.equal(options.redirect,'error');const response=fail?.(url,requests.length);if(response)return response;return new Response(url.pathname.endsWith('/index.json')?JSON.stringify(index):bytes);};
  const client=createQuestionRepairs(new URL('https://reader.test/repairs/'),bank());
  try{await run(client,requests);}finally{client.dispose();globalThis.fetch=old;}
}

test('repair fetch validates shard hash and full identity before giving consumers a grading correction',async()=>{
  await fixture(async(client,requests)=>{const state=await client.get(target);assert.equal(state.state,'ready');assert.equal(state.materials.length,1);assert.match(state.repairDigest,/^[a-f0-9]{64}$/);assert.equal(requests.length,2);});
  await fixture(async client=>{assert.deepEqual(await client.get(target),{state:'stale'});},{indexMutation:i=>i.manifestHash='f'.repeat(64)});
  await fixture(async client=>{await assert.rejects(client.get(target),/repair_hash_mismatch/);},{fail:url=>url.pathname.includes('/v1/')?new Response('tampered'):null});
});

test('a failed catalog stays a visible error, can be explicitly retried, and never becomes missing',async()=>{
  let failed=true;
  await fixture(async(client,requests)=>{
    await assert.rejects(client.get(target),/network_http_404/);await assert.rejects(client.get(target),/network_http_404/);
    assert.equal(requests.length,1);failed=false;client.refresh();assert.equal((await client.get(target)).state,'ready');
  },{fail:()=>failed?new Response('',{status:404}):null});
});

test('empty repair directory is a successful absence; cancellation cannot display old materials',async()=>{
  await fixture(async client=>{assert.deepEqual(await client.get(target),{state:'missing'});},{indexMutation:i=>{i.shards=[];i.recordCount=0;}});
  await fixture(async client=>{const controller=new AbortController();controller.abort();await assert.rejects(client.get(target,controller.signal),{name:'AbortError'});});
});

test('published repair catalog and shards satisfy runtime schema and exact hashes',async()=>{
  const root=new URL('../supplements/repairs/reader/',import.meta.url),index=validateIndex(JSON.parse(await readFile(new URL('index.json',root))));
  for(const ref of index.shards){const bytes=await readFile(new URL(ref.path,root));assert.equal(bytes.length,ref.byteLength);assert.equal(await hash(bytes),ref.sha256);assert.equal(validateRepairShard(JSON.parse(bytes),index,ref).size,ref.recordCount);}
});
