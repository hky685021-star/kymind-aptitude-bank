// Public-web adapter; bank.page verifies signed bytes before the Worker sees them.
// Worker memory belongs to one pinned bank/release/hash and dies with this page.
import {parseQuery,SEARCH_LIMITS} from './search-index.mjs';
export function createSearchClient(bank,collections,onProgress=()=>{},makeWorker=()=>new Worker(new URL('./search-worker.mjs',import.meta.url),{type:'module'})){
  const worker=makeWorker(),pending=new Map(),loaded=new Set();let nextId=0,disposed=false;
  worker.onmessage=({data})=>{const request=pending.get(data.id);if(!request)return;pending.delete(data.id);request.cleanup();data.error?request.reject(Error(data.error)):request.resolve(data.result);};
  const rejectAll=error=>{for(const p of pending.values()){p.cleanup();p.reject(error);}pending.clear();};
  worker.onerror=()=>{disposed=true;worker.terminate();rejectAll(Error('search_worker_failed'));};
  function call(kind,body={},signal){
    if(disposed)return Promise.reject(Error('search_disposed'));
    if(signal?.aborted)return Promise.reject(Error('cancelled'));
    return new Promise((resolve,reject)=>{const id=++nextId;let timer;const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};const abort=()=>{pending.delete(id);cleanup();reject(Error('cancelled'));};pending.set(id,{resolve,reject,cleanup,kind});signal?.addEventListener('abort',abort,{once:true});timer=setTimeout(()=>{pending.delete(id);cleanup();reject(Error('search_worker_timeout'));},30000);worker.postMessage({id,kind,...body});});
  }
  const ready=call('init',{scope:[bank.manifest.bankId,bank.manifest.releaseId,bank.entry.currentRelease?.manifestHash||'local-preview'].join(':'),collections});
  // Preserve the rejection for query(), but avoid an unhandled startup rejection
  // if a browser blocks Workers before the user presses Search.
  void ready.catch(()=>{});
  // First load is bounded concurrency; later queries and "more" do zero page IO.
  async function prepare(signal){
    await ready;let cursor=0,failure;
    const controller=new AbortController(),abort=()=>controller.abort();
    if(signal?.aborted)abort();signal?.addEventListener('abort',abort,{once:true});
    const lanes=Array.from({length:Math.min(4,bank.root.pages.length)},async()=>{
      try{while(cursor<bank.root.pages.length){const page=cursor++;if(loaded.has(page))continue;if(controller.signal.aborted)throw Error('cancelled');const items=await bank.page(page,controller.signal);await call('append',{page,items},controller.signal);loaded.add(page);onProgress(loaded.size,bank.root.pages.length);}}
      catch(error){failure??=error;controller.abort();throw error;}
    });
    // Wait for all lanes to settle before allowing a retry; no old lane keeps loading.
    try{await Promise.allSettled(lanes);if(failure)throw failure;}finally{signal?.removeEventListener('abort',abort);}
  }
  return {
    pageSize:SEARCH_LIMITS.page,
    async facets(signal){await prepare(signal);return call('facets',{},signal);},
    async query(input,signal){if(disposed)throw Error('search_disposed');parseQuery(input.query||'');await prepare(signal);if(signal?.aborted)throw Error('cancelled');return call('query',{input},signal);},
    cancel(){worker.postMessage({kind:'cancel'});for(const [id,p] of pending){if(p.kind!=='query')continue;pending.delete(id);p.cleanup();p.reject(Error('cancelled'));}},
    dispose(){if(disposed)return;disposed=true;worker.terminate();rejectAll(Error('search_disposed'));}
  };
}
