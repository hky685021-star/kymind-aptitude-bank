// External recovery is a separate, reviewed sidecar, never a change to signed questions.
// Source URLs are citation links only. Only locally stored, content-addressed bytes load.
import {boundedFetch,hash} from './core.mjs';

const enc=new TextEncoder(),HEX=/^[a-f0-9]{64}$/;
const object=v=>v&&typeof v==='object'&&!Array.isArray(v);
const require=(ok,why='external_material_invalid')=>{if(!ok)throw Error(why);};
const text=(v,max)=>typeof v==='string'&&v.trim().length>0&&v.length<=max&&!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(v);
const strings=(v,max,limit)=>Array.isArray(v)&&v.length<=max&&v.every(x=>text(x,limit));
const day=v=>typeof v==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(v)&&Number.isFinite(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;
const KEY=['bankId','releaseId','manifestHash','questionId','revisionDigest'];

export function validateSourceUrl(value) {
  require(text(value,2048)&&!/[\s\x00-\x1f\x7f\\]/.test(value),'external_url_invalid');
  const authority=/^https:\/\/([^/?#]+)/.exec(value)?.[1];
  require(authority&&/^[a-zA-Z0-9.-]+(?::443)?$/.test(authority),'external_url_invalid');
  const url=new URL(value),host=url.hostname;
  require(url.protocol==='https:'&&!url.username&&!url.password&&(!url.port||url.port==='443'),'external_url_invalid');
  require(host.length<=253&&host.includes('.')&&host.split('.').every(x=>/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(x))&&/^[a-z]{2,63}$/.test(host.split('.').at(-1)),'external_url_invalid');
  require(!/(^|\.)(localhost|local|internal|test|invalid|example|onion|home|lan)$/.test(host),'external_url_invalid');
  return value;
}

export function validateExternalMaterials(record) {
  const rows=record.externalMaterials;
  if(rows===undefined){require(record.externalReview===undefined||record.externalReview===null);return;}
  require(Array.isArray(rows)&&rows.length<=8);
  const ids=new Set(),hashes=new Set();let bytes=0,pixels=0,count=0;
  for(const row of rows) {
    require(object(row)&&text(row.materialId,200)&&!ids.has(row.materialId));ids.add(row.materialId);
    require(['image','text-summary','text-data'].includes(row.kind)&&text(row.title,300)&&text(row.identityEvidence,4000)&&day(row.checkedOn)&&HEX.test(row.contentSha256));
    require(!hashes.has(row.contentSha256));hashes.add(row.contentSha256);
    validateSourceUrl(row.sourcePageUrl);if(row.sourceAssetUrl!==null)validateSourceUrl(row.sourceAssetUrl);
    if(row.kind==='image') {
      const a=row.asset,extensions={'image/png':'png','image/jpeg':'jpg','image/bmp':'bmp'};
      require(row.text===null&&object(a)&&Object.hasOwn(extensions,a.mimeType)&&HEX.test(a.sha256)&&row.contentSha256===a.sha256);
      require(a.path===`assets/${a.sha256}.${extensions[a.mimeType]}`,'external_asset_path_invalid');
      require(Number.isSafeInteger(a.byteLength)&&a.byteLength>0&&a.byteLength<=8*1024*1024,'external_image_budget');
      require([a.width,a.height].every(n=>Number.isSafeInteger(n)&&n>0&&n<=8192),'external_image_dimensions');
      bytes+=a.byteLength;pixels+=a.width*a.height;count++;
    } else require(row.asset===null&&text(row.text,16000));
  }
  checkImageBudget(count,bytes,pixels);
  const review=record.externalReview;
  if(review===null||review===undefined)return;
  require(rows.length&&object(review)&&object(review.key)&&Object.keys(review.key).length===KEY.length&&KEY.every(k=>review.key[k]===record.key[k]),'external_review_key_mismatch');
  require(Array.isArray(review.materialHashes)&&review.materialHashes.length===hashes.size&&new Set(review.materialHashes).size===hashes.size&&review.materialHashes.every(h=>hashes.has(h)),'external_review_hash_mismatch');
  require(['reviewed','needs-review'].includes(review.reviewStatus)&&['sufficient','partial'].includes(review.coverage)&&day(review.reviewedOn));
  require(strings(review.identityChecks,32,4000)&&strings(review.limitations,32,4000)&&text(review.coverageReason,4000));
  if(review.coverage==='sufficient')require(review.reviewStatus==='reviewed'&&review.identityChecks.length>=3&&!review.limitations.length,'external_review_insufficient');
  else require(review.limitations.length>0,'external_review_limitations_missing');
}

export function sufficientExternalCoverage(record) {
  return Boolean(record.externalMaterials?.length&&record.externalReview?.reviewStatus==='reviewed'&&record.externalReview.coverage==='sufficient');
}
export function checkImageBudget(count,bytes,pixels) {
  require(count<=32&&bytes<=16*1024*1024&&pixels<=64000000,'repair_image_budget');
}

// Inspect allocation dimensions before a browser decoder sees untrusted pixels.
// Browser decode and actual dimensions are independently checked by the view.
export function imageDimensions(bytes,mime) {
  const view=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength),n=bytes.length;
  const u32=(p,little=false)=>view.getUint32(p,little);
  let width,height;
  if(mime==='image/png') {
    require(n>=33&&[137,80,78,71,13,10,26,10].every((b,i)=>bytes[i]===b),'external_image_magic');
    let position=8,first=true,ended=false;
    while(position<n) {
      require(position+12<=n,'external_image_header');const size=u32(position);
      require(size<=n-position-12,'external_image_header');
      const kind=String.fromCharCode(...bytes.subarray(position+4,position+8));
      if(first){require(kind==='IHDR'&&size===13,'external_image_header');width=u32(position+8);height=u32(position+12);first=false;}
      require(kind!=='acTL','external_image_animated');
      position+=12+size;
      if(kind==='IEND'){require(size===0&&position===n,'external_image_header');ended=true;break;}
    }
    require(ended,'external_image_header');
  } else if(mime==='image/jpeg') {
    require(n>=4&&bytes[0]===255&&bytes[1]===216&&bytes[2]===255,'external_image_magic');
    let p=2;
    while(p<n) {
      require(bytes[p++]===255,'external_image_header');while(bytes[p]===255)p++;
      const marker=bytes[p++];if(marker===0xd9||marker===0xda)break;
      if(marker===0x01||(marker>=0xd0&&marker<=0xd7))continue;
      require(p+2<=n,'external_image_header');const length=view.getUint16(p);
      require(length>=2&&p+length<=n,'external_image_header');
      if([0xc0,0xc1,0xc2,0xc3,0xc5,0xc6,0xc7,0xc9,0xca,0xcb,0xcd,0xce,0xcf].includes(marker)) {
        require(length>=8&&!width,'external_image_header');height=view.getUint16(p+3);width=view.getUint16(p+5);
      }
      p+=length;
    }
  } else if(mime==='image/bmp') {
    require(n>=26&&bytes[0]===66&&bytes[1]===77,'external_image_magic');const size=u32(14,true);
    if(size===12){width=view.getUint16(18,true);height=view.getUint16(20,true);}
    else {require(size>=40&&n>=14+size,'external_image_header');width=view.getInt32(18,true);height=Math.abs(view.getInt32(22,true));}
  } else throw Error('external_image_mime');
  require([width,height].every(v=>Number.isSafeInteger(v)&&v>0&&v<=8192)&&width*height<=64000000,'external_image_dimensions');
  return {width,height};
}

export async function resolveExternalMaterials(base,record,internalMaterials=[],signal) {
  validateExternalMaterials(record);
  if(!record.externalMaterials?.length||record.externalReview?.reviewStatus!=='reviewed')return [];
  let bytesTotal=internalMaterials.reduce((n,m)=>n+m.imageBytes,0),count=internalMaterials.reduce((n,m)=>n+m.mediaOccurrences.length,0),pixels=0;
  const result=[];
  for(const material of record.externalMaterials) {
    if(signal?.aborted)throw new DOMException('Aborted','AbortError');
    if(material.kind==='image') {
      const a=material.asset,url=new URL('../'+a.path,base);
      require(url.origin===new URL(base).origin,'external_asset_origin');
      count++;bytesTotal+=a.byteLength;pixels+=a.width*a.height;checkImageBudget(count,bytesTotal,pixels);
      const bytes=await boundedFetch(url,a.byteLength,signal);
      require(bytes.length===a.byteLength&&await hash(bytes)===a.sha256,'external_image_hash_mismatch');
      const dimensions=imageDimensions(bytes,a.mimeType);
      require(dimensions.width===a.width&&dimensions.height===a.height,'external_image_dimensions_mismatch');
      result.push({...material,blob:new Blob([bytes],{type:a.mimeType})});
    } else {
      require(await hash(enc.encode(material.text))===material.contentSha256,'external_text_hash_mismatch');
      result.push(material);
    }
  }
  return result;
}
