import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {hash} from '../online/core.mjs';
import {createSavedSupplements,validateIndex,validateShard} from '../online/saved-supplements.mjs';

const root = new URL('../supplements/reader/',import.meta.url);
// Pin unit fixtures to the preserved seven-sample inputs, not the mutable published
// catalog: later batches may legitimately replace every review status/content.
const sampleAI = (await readFile(new URL('../supplements/ai/batches/2026-11-06-seven-samples/records.jsonl',import.meta.url),'utf8')).trim().split('\n').map(JSON.parse);
const sampleKey = sampleAI[0].key;
const catalog = {schemaVersion:1,bankId:sampleKey.bankId,releaseId:sampleKey.releaseId,manifestHash:sampleKey.manifestHash,recordCount:sampleAI.length,shards:[]};
const source = {...catalog,prefix:'00',records:sampleAI.map(row=>({key:row.key,ai:{...row,batchId:'seven-samples'},models:{batchId:'seven-samples',dictionaryVersion:'test',knowledgeCategory:'测试分类',reviewStatus:'pending',basis:'测试依据',pendingReasons:[],dimensions:{concept:[],model:[],target:[],context:[]}}}))};
const fixtureBytes=new TextEncoder().encode(JSON.stringify(source)), fixtureHash=await hash(fixtureBytes);
catalog.shards.push({prefix:'00',path:`v1/00-${fixtureHash}.json`,sha256:fixtureHash,byteLength:fixtureBytes.length,recordCount:sampleAI.length});
const question = {...source.records[0].key};
const scope = {bankId:catalog.bankId,releaseId:catalog.releaseId,manifestHash:catalog.manifestHash};
const url = new URL('https://reader.test/supplements/reader/');
const enc = new TextEncoder();
const originalFetch = globalThis.fetch;
const clone = v => structuredClone(v);
async function fixture(operation,{mutateIndex,mutateShard,fail} = {}) {
  const index=clone(catalog), shard=clone(source);
  if(mutateShard) mutateShard(shard);
  const bytes=enc.encode(JSON.stringify(shard));
  index.shards[0].sha256=await hash(bytes);
  index.shards[0].byteLength=bytes.length;
  index.shards[0].path=`v1/${index.shards[0].prefix}-${index.shards[0].sha256}.json`;
  if(mutateIndex) mutateIndex(index);
  const calls=[];
  globalThis.fetch=async(target,options)=>{
    target=new URL(target);calls.push(target);
    assert.equal(target.origin,url.origin);assert.ok(target.pathname.startsWith(url.pathname));
    assert.equal(options.redirect,'error');
    if(fail) { const failed=await fail(target,calls.length); if(failed) return failed; }
    if(target.pathname.endsWith('/index.json'))return new Response(JSON.stringify(index));
    assert.equal(target.pathname,url.pathname+index.shards[0].path);
    return new Response(bytes);
  };
  const client=createSavedSupplements(url,scope);
  try { await operation(client,calls); } finally { client.dispose();globalThis.fetch=originalFetch; }
}

test('saved content is lazy, separately accessible, cached, and exactly revision scoped',async()=>{
  await fixture(async(client,calls)=>{
    assert.equal(calls.length,0);
    const result=await client.get(question);
    assert.equal(result.state,'ready');assert.ok(result.ai.focusAnalysis);assert.ok(result.ai.quickTip);
    assert.equal(result.ai.reviewStatus,'needs-review');assert.equal(result.models.reviewStatus,'pending');
    assert.equal((await client.get(question)).ai.focusAnalysis,result.ai.focusAnalysis);
    assert.equal(calls.length,2);
    assert.deepEqual(await client.get({...question,revisionDigest:'a'.repeat(64)}),{state:'stale'});
  });
});

test('absence in both an absent prefix and present shard is distinct from load failure',async()=>{
  await fixture(async(client,calls)=>{
    assert.deepEqual(await client.get({...question,questionId:'q_ff'+'0'.repeat(62)}),{state:'missing'});
    assert.equal(calls.length,1);
    assert.deepEqual(await client.get({...question,questionId:'q_00'+'0'.repeat(62)}),{state:'missing'});
    assert.equal(calls.length,2);
  });
});

test('different bank, release, or manifest refuses old supplements without fetching a shard',async()=>{
  for(const key of ['bankId','releaseId','manifestHash']) await fixture(async(client,calls)=>{
    assert.deepEqual(await client.get(question),{state:'stale'});assert.equal(calls.length,1);
  },{mutateIndex:index=>{index[key]=key==='manifestHash'?'f'.repeat(64):'different';}});
});

test('HTTP 404, 503, malformed index and invalid hashes are errors, never missing content',async()=>{
  for(const status of [404,503]) await fixture(async client=>{
    await assert.rejects(client.get(question),new RegExp('network_http_'+status));
  },{fail:async()=>new Response('',{status})});
  await fixture(async client=>{await assert.rejects(client.get(question),SyntaxError);},
    {fail:async target=>target.pathname.endsWith('/index.json')?new Response('<html>not json</html>'):null});
  await fixture(async client=>{await assert.rejects(client.get(question),/supplement_hash_mismatch/);},
    {fail:async target=>target.pathname.endsWith('/index.json')?null:new Response('tampered')});
});

test('failed catalog or shard reads are retryable and not permanently cached',async()=>{
  for(const targetName of ['index.json','.json']) {
    let failures=0;
    await fixture(async(client,calls)=>{
      await assert.rejects(client.get(question),/network_http_503/);
      assert.equal((await client.get(question)).state,'ready');
      const before=calls.length; client.refresh();
      assert.equal((await client.get(question)).state,'ready');assert.ok(calls.length>before);
    },{fail:async target=>{
      const matches=targetName==='index.json'?target.pathname.endsWith('/index.json'):!target.pathname.endsWith('/index.json');
      return matches&&failures++===0?new Response('',{status:503}):null;
    }});
  }
});

test('repeated concurrent reads share bounded requests, consumer cancellation does not poison another',async()=>{
  await fixture(async(client,calls)=>{
    const abort=new AbortController();const cancelled=client.get(question,abort.signal);abort.abort();
    await assert.rejects(cancelled,{name:'AbortError'});
    const results=await Promise.all(Array.from({length:10},()=>client.get(question)));
    assert.ok(results.every(result=>result.state==='ready'));assert.equal(calls.length,2);
  });
});

test('blocked content is retained with blocked status and does not become reviewed',async()=>{
  await fixture(async client=>{
    const q=source.records.find(row=>row.ai?.reviewStatus==='blocked').key;
    const result=await client.get(q);
    assert.equal(result.ai.reviewStatus,'blocked');assert.ok(result.ai.sourceIssues.includes('missing-material'));
    assert.equal(result.models.reviewStatus,'pending');
  });
});

test('index rejects traversal, off-origin paths, duplicates and resource overruns',()=>{
  for(const mutate of [
    i=>{i.shards[0].path='https://evil.test/x';},i=>{i.shards[0].path='../private';},
    i=>{i.shards.push(clone(i.shards[0]));},i=>{i.shards[0].byteLength=4*1024*1024+1;},
    i=>{i.shards[0].recordCount=2001;},i=>{i.recordCount++;},i=>{i.schemaVersion=2;}
  ]) {const index=clone(catalog);mutate(index);assert.throws(()=>validateIndex(index));}
});

test('shards reject mismatched identity, duplicates, malformed statuses and excessive content',()=>{
  for(const mutate of [
    s=>{s.records[0].key.bankId='wrong';},s=>{s.records[0].key.revisionDigest='wrong';},
    s=>{s.records[1]=clone(s.records[0]);},s=>{s.records[0].ai.reviewStatus='approved';},
    s=>{s.records[0].ai.focusAnalysis='a'.repeat(16001);},s=>{s.records[0].ai.quickTip='';},
    s=>{s.records[0].ai.sourceIssues=['unknown'];},
    s=>{s.records[0].ai.reviewStatus='reviewed';s.records[0].ai.sourceIssues=['answer-conflict'];},
    s=>{s.records[0].models.dimensions.model=[{code:'x',label:'x',definition:'x',reviewStatus:'approved'}];}
  ]) {const shard=clone(source);mutate(shard);assert.throws(()=>validateShard(shard,catalog,catalog.shards[0]));}
});

test('HTML-looking strings remain data: no sanitization changes saved content',()=>{
  const shard=clone(source);shard.records[0].ai.focusAnalysis='<img src=x onerror=alert(1)><script>alert(1)</script>';
  const rows=validateShard(shard,catalog,catalog.shards[0]);
  assert.equal(rows.get(question.questionId).ai.focusAnalysis,shard.records[0].ai.focusAnalysis);
});


test('published reader catalog and every immutable shard pass exact bytes/hash/schema verification',async()=>{
  const index=validateIndex(JSON.parse(await readFile(new URL('index.json',root))));
  for(const ref of index.shards) {
    const bytes=await readFile(new URL(ref.path,root));
    assert.equal(bytes.length,ref.byteLength);assert.equal(await hash(bytes),ref.sha256);
    assert.equal(validateShard(JSON.parse(bytes),index,ref).size,ref.recordCount);
  }
});
