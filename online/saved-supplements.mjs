// Saved public sidecars only. No inference, credentials, HTML or external URLs.
import {boundedFetch, hash} from './core.mjs';

const decoder = new TextDecoder('utf-8', {fatal:true});
const HEX = /^[a-f0-9]{64}$/;
const QID = /^q_[a-f0-9]{64}$/;
const DIMENSIONS = ['concept','model','target','context'];
const ISSUES = new Set(['missing-image','missing-material','answer-conflict','source-unverified']);
const require = (ok, reason = 'supplement_invalid') => { if (!ok) throw Error(reason); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const string = (value, max = 16000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const strings = (value, max = 32, length = 2000) => Array.isArray(value) && value.length <= max && value.every(v => string(v,length));
const matchingScope = (a,b) => ['bankId','releaseId','manifestHash'].every(k => a[k] === b[k]);

export function validateIndex(value) {
  require(object(value) && value.schemaVersion === 1 && string(value.bankId,100) && string(value.releaseId,100) && HEX.test(value.manifestHash));
  require(Number.isSafeInteger(value.recordCount) && value.recordCount >= 0 && value.recordCount <= 200000);
  require(Array.isArray(value.shards) && value.shards.length <= 256);
  let count = 0; const seen = new Set();
  for (const ref of value.shards) {
    require(object(ref) && /^[a-f0-9]{2}$/.test(ref.prefix) && !seen.has(ref.prefix) && HEX.test(ref.sha256));
    require(ref.path === `v1/${ref.prefix}-${ref.sha256}.json`, 'supplement_path_invalid');
    require(Number.isSafeInteger(ref.byteLength) && ref.byteLength > 0 && ref.byteLength <= 4*1024*1024);
    require(Number.isSafeInteger(ref.recordCount) && ref.recordCount > 0 && ref.recordCount <= 2000);
    seen.add(ref.prefix); count += ref.recordCount;
  }
  require(count === value.recordCount);
  return value;
}

export function validateShard(value,index,ref) {
  require(object(value) && value.schemaVersion === 1 && matchingScope(value,index) && value.prefix === ref.prefix);
  require(Array.isArray(value.records) && value.records.length === ref.recordCount);
  const records = new Map();
  for (const row of value.records) {
    require(object(row) && object(row.key));
    const key = row.key;
    require(matchingScope(key,index) && QID.test(key.questionId) && key.questionId.slice(2,4) === ref.prefix && HEX.test(key.revisionDigest) && !records.has(key.questionId));
    require(row.ai === null || object(row.ai)); require(row.models === null || object(row.models));
    if (row.ai) {
      const ai = row.ai;
      require(string(ai.batchId,100) && ['reviewed','needs-review','blocked'].includes(ai.reviewStatus));
      require(string(ai.focusAnalysis) && string(ai.quickTip));
      require(strings(ai.sourceIssues,4,40) && new Set(ai.sourceIssues).size === ai.sourceIssues.length && ai.sourceIssues.every(v => ISSUES.has(v)));
      require(ai.reviewStatus !== 'reviewed' || ai.sourceIssues.length === 0);
    }
    if (row.models) {
      const model = row.models;
      require(string(model.batchId,100) && string(model.dictionaryVersion,200) && string(model.knowledgeCategory,200));
      require(['reviewed','pending','quarantined'].includes(model.reviewStatus) && string(model.basis) && strings(model.pendingReasons));
      require(object(model.dimensions));
      for (const dimension of DIMENSIONS) {
        const terms = model.dimensions[dimension];
        require(Array.isArray(terms) && terms.length <= 32);
        const codes = new Set();
        for (const term of terms) {
          require(object(term) && string(term.code,200) && !codes.has(term.code) && string(term.label,200) && string(term.definition,2000) && ['pending','reviewed'].includes(term.reviewStatus));
          codes.add(term.code);
        }
      }
    }
    records.set(key.questionId,row);
  }
  return records;
}

function abortable(promise, signal) {
  if (!signal) return promise;
  if (signal.aborted) return Promise.reject(new DOMException('Aborted','AbortError'));
  return new Promise((resolve,reject) => {
    const abort = () => reject(new DOMException('Aborted','AbortError'));
    signal.addEventListener('abort',abort,{once:true});
    promise.then(resolve,reject).finally(() => signal.removeEventListener('abort',abort));
  });
}

export function createSavedSupplements(base, scope) {
  // Single-flight requests prevent repeated clicks or nearby questions multiplying reads.
  // Consumer cancellation stops display, while a shared bounded read may finish for others.
  let controller = new AbortController(), indexFlight;
  const cache = new Map(), flights = new Map();
  const index = () => indexFlight ||= boundedFetch(new URL('index.json',base),256*1024,controller.signal)
    .then(bytes => validateIndex(JSON.parse(decoder.decode(bytes))))
    .catch(error => { indexFlight = undefined; throw error; });
  async function page(catalog,ref) {
    if (cache.has(ref.sha256)) return cache.get(ref.sha256);
    if (flights.has(ref.sha256)) return flights.get(ref.sha256);
    require(flights.size < 4,'supplement_busy');
    const flight = (async () => {
      const bytes = await boundedFetch(new URL(ref.path,base),ref.byteLength,controller.signal);
      require(bytes.length === ref.byteLength && await hash(bytes) === ref.sha256,'supplement_hash_mismatch');
      const records = validateShard(JSON.parse(decoder.decode(bytes)),catalog,ref);
      cache.set(ref.sha256,records);
      while (cache.size > 4) cache.delete(cache.keys().next().value);
      return records;
    })();
    flights.set(ref.sha256,flight);
    try { return await flight; } finally { flights.delete(ref.sha256); }
  }
  return {
    async get(question,signal) {
      require(question.bankId === scope.bankId && QID.test(question.questionId) && HEX.test(question.revisionDigest));
      const catalog = await abortable(index(),signal);
      if (!matchingScope(catalog,scope)) return {state:'stale'};
      const ref = catalog.shards.find(ref => ref.prefix === question.questionId.slice(2,4));
      if (!ref) return {state:'missing'};
      const row = (await abortable(page(catalog,ref),signal)).get(question.questionId);
      if (!row) return {state:'missing'};
      if (row.key.revisionDigest !== question.revisionDigest) return {state:'stale'};
      return {state:'ready',ai:row.ai,models:row.models};
    },
    refresh() { indexFlight = undefined; cache.clear(); },
    dispose() { controller.abort(); cache.clear(); flights.clear(); }
  };
}
