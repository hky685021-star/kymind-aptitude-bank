import test from 'node:test';
import assert from 'node:assert/strict';
import {hash} from '../online/core.mjs';
import {imageDimensions,resolveExternalMaterials,validateExternalMaterials,validateSourceUrl} from '../online/external-materials.mjs';
import {evaluateWithRepairs,validateRepairRecord} from '../online/question-repairs.mjs';
const enc=new TextEncoder(),clone=structuredClone;
const scope={bankId:'bank-test',releaseId:'release-test',manifestHash:'a'.repeat(64)};
const question={bankId:scope.bankId,questionId:'q_'+'1'.repeat(64),revisionDigest:'b'.repeat(64),type:'single-choice',options:[{optionId:'a'},{optionId:'b'}],answer:{grading:'objective',optionIds:['b']}};
const key={...scope,questionId:question.questionId,revisionDigest:question.revisionDigest};
const text='原表数据 <script>alert(1)</script>：2021年 180\n2022年 200。 ';
const material={materialId:'source-table',kind:'text-data',title:'恢复表格',sourcePageUrl:'https://example.com/exam/1',sourceAssetUrl:null,checkedOn:'2026-11-06',identityEvidence:'题组、题干及四个选项一致',contentSha256:await hash(enc.encode(text)),text,asset:null};
const review={key,materialHashes:[material.contentSha256],reviewStatus:'reviewed',coverage:'sufficient',reviewedOn:'2026-11-06',identityChecks:['题组编号一致','题干设问一致','四个选项一致'],coverageReason:'所需原表数值完整',limitations:[]};
const record={schemaVersion:1,key,reviewStatus:'blocked',materialLinks:[],sourceIssues:['missing-material'],answerCorrection:null,externalMaterials:[material],externalReview:review};
const state=r=>({state:'ready',record:r,repairDigest:'c'.repeat(64)});
const png=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jS1kAAAAASUVORK5CYII=','base64'));
const sha=await hash(png);
const image={...material,kind:'image',text:null,contentSha256:sha,asset:{path:`assets/${sha}.png`,sha256:sha,byteLength:png.length,mimeType:'image/png',width:1,height:1}};
const imageRecord={...record,externalMaterials:[image],externalReview:{...review,materialHashes:[sha]}};

test('only independently reviewed sufficient material unlocks original-answer grading, regardless of AI status',()=>{
  validateRepairRecord(record,scope);
  assert.equal(evaluateWithRepairs(question,['b'],state(record)).evaluation,'correct');
  assert.equal(evaluateWithRepairs(question,['a'],state(record)).evaluation,'incorrect');
  for(const externalReview of [null,undefined,{...review,coverage:'partial',limitations:['原文措辞尚未恢复']},{...review,reviewStatus:'needs-review',coverage:'partial',limitations:['尚未核验']}]) {
    const r={...record,sourceIssues:[],complete:true,externalReview};validateRepairRecord(r,scope);
    assert.equal(evaluateWithRepairs(question,['b'],state(r)).mode,'withheld');
  }
  const complete={...record,sourceIssues:['answer-conflict'],externalMaterials:[],externalReview:null};
  assert.equal(evaluateWithRepairs(question,['b'],state(complete)).mode,'original');
});

test('review must bind exact key and every material hash with explicit coverage evidence',()=>{
  for(const mutate of [
    r=>r.externalReview.key.revisionDigest='d'.repeat(64),r=>r.externalReview.key.extra='x',
    r=>r.externalReview.materialHashes=[],r=>r.externalReview.materialHashes=[material.contentSha256,material.contentSha256],
    r=>r.externalReview.materialHashes=['d'.repeat(64)],r=>r.externalReview.identityChecks=['only one'],
    r=>r.externalReview.limitations=['missing detail'],r=>r.externalReview.reviewStatus='needs-review',
    r=>{r.externalReview.coverage='partial';r.externalReview.limitations=[];},r=>r.externalReview.reviewedOn='2026-02-30',
    r=>r.externalMaterials.push(clone(material)),r=>r.externalMaterials[0].text='\ud800'
  ]){const r=clone(record);r.externalReview.key={...r.externalReview.key};mutate(r);assert.throws(()=>validateExternalMaterials(r),mutate.toString());}
});

test('source URLs are only HTTPS public-domain references with no executable or private destinations',()=>{
  assert.equal(validateSourceUrl('https://www.example.com/image.png?size=600'), 'https://www.example.com/image.png?size=600');
  for(const url of ['https:example.com','https:///example.com','https://@example.com','https://%65xample.com','https://例子.com','http://example.com','javascript:alert(1)','data:image/png;base64,aa','https://user:password@example.com','https://example.com:8080/x','https://127.0.0.1/x','https://2130706433/x','https://[::1]/','https://example.local/a','https://localhost/','https://www.example.com\\@evil.org','https://example.com/\nfoo'])assert.throws(()=>validateSourceUrl(url));
});

test('text content uses exact UTF8 bytes, no newline normalization or remote source fetch',async()=>{
  const old=globalThis.fetch;globalThis.fetch=()=>{throw Error('Unexpected source network request');};
  try {
    const result=await resolveExternalMaterials(new URL('https://reader.example.com/repairs/reader/'),record);
    assert.equal(result[0].text,text);
    const changed=clone(record);changed.externalMaterials[0].text+='\n';await assert.rejects(resolveExternalMaterials('https://reader.example.com/repairs/reader/',changed),/external_text_hash_mismatch/);
    assert.deepEqual(await resolveExternalMaterials('https://reader.example.com/repairs/reader/',{...record,externalReview:null}),[]);
    const partial={...record,externalReview:{...review,coverage:'partial',limitations:['部分原文缺失']}};
    assert.equal((await resolveExternalMaterials('https://reader.example.com/repairs/reader/',partial)).length,1);
    assert.equal(evaluateWithRepairs(question,['b'],state(partial)).mode,'withheld');
  } finally {globalThis.fetch=old;}
});

test('local assets are bounded and exact-hash checked, and failed loads never become absence',async()=>{
  let mode='ok';const old=globalThis.fetch,requests=[];
  globalThis.fetch=async(url,options)=>{requests.push(String(url));assert.equal(options.redirect,'error');return mode==='http'?new Response('',{status:404}):new Response(mode==='hash'?new Uint8Array(png.length):png);};
  try {
    const base='https://reader.example.com/supplements/repairs/reader/';
    const loaded=await resolveExternalMaterials(base,imageRecord);assert.equal(loaded[0].blob.type,'image/png');
    assert.equal(requests[0],`https://reader.example.com/supplements/repairs/assets/${sha}.png`);
    mode='hash';await assert.rejects(resolveExternalMaterials(base,imageRecord),/external_image_hash_mismatch/);
    mode='http';await assert.rejects(resolveExternalMaterials(base,imageRecord),/network_http_404/);
    mode='ok';assert.equal((await resolveExternalMaterials(base,imageRecord)).length,1);
    const controller=new AbortController();controller.abort();await assert.rejects(resolveExternalMaterials(base,imageRecord,[],controller.signal),{name:'AbortError'});
    await assert.rejects(resolveExternalMaterials(base,imageRecord,[{imageBytes:16*1024*1024,mediaOccurrences:[]}]),/repair_image_budget/);
  }finally{globalThis.fetch=old;}
});

test('image paths, formats, headers, dimensions and allocation budgets fail closed',async()=>{
  assert.deepEqual(imageDimensions(png,'image/png'),{width:1,height:1});
  for(const mutate of [r=>r.externalMaterials[0].asset.path='../original.png',r=>r.externalMaterials[0].asset.mimeType='image/svg+xml',r=>r.externalMaterials[0].asset.byteLength=8*1024*1024+1,r=>r.externalMaterials[0].asset.width=8193,r=>r.externalMaterials[0].asset.width=8192,r=>r.externalMaterials[0].contentSha256='f'.repeat(64)]) {
    const r=clone(imageRecord);mutate(r);if(r.externalMaterials[0].asset.width===8192)r.externalMaterials[0].asset.height=8192;assert.throws(()=>validateExternalMaterials(r));
  }
  assert.throws(()=>imageDimensions(png,'image/jpeg'),/external_image_magic/);
  assert.throws(()=>imageDimensions(enc.encode('<svg>'),'image/png'),/external_image_magic/);
  const oversized=png.slice();new DataView(oversized.buffer).setUint32(16,1000000);assert.throws(()=>imageDimensions(oversized,'image/png'),/external_image_dimensions/);
  const animated=png.slice();animated.set(enc.encode('acTL'),37);assert.throws(()=>imageDimensions(animated,'image/png'),/external_image_animated/);
  const old=globalThis.fetch;globalThis.fetch=async()=>new Response(png);
  try{const bad=clone(imageRecord);bad.externalMaterials[0].asset.width=2;await assert.rejects(resolveExternalMaterials('https://reader.example.com/repairs/reader/',bad),/external_image_dimensions_mismatch/);}finally{globalThis.fetch=old;}
});
