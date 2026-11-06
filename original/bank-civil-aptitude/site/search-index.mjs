// One release-scoped, derived index. No fetch, DOM, answer bodies or persistence.
export const SEARCH_LIMITS = Object.freeze({rows:1000000, bytes:128*1024*1024, text:256*1024, page:100, query:512, terms:16});
export function extractSearchText(question){
  let text='';const visit=n=>{if(typeof n.text==='string')text+=n.text;if(typeof n.attrs?.latex==='string')text+=n.attrs.latex;for(const c of n.content||[])visit(c);if(['paragraph','heading','hardBreak'].includes(n.type))text+='\n';};
  visit(question.stem.doc);for(const o of question.options){text+='\n';visit(o.content.doc);}
  if(new TextEncoder().encode(text).length>SEARCH_LIMITS.text)throw Error('search_text_budget');return text;
}
export function parseQuery(value) {
  if(typeof value!=='string'||value.length>SEARCH_LIMITS.query)throw Error('search_query_budget');
  const include=[],exclude=[];let token='',negative=false,escaped=false;
  const flush=()=>{const text=token.trim().toLocaleLowerCase();if(text)(negative?exclude:include).push(text);token='';};
  for(const ch of value){if(escaped){token+=ch;escaped=false;}else if(ch==='\\'){escaped=true;}else if(ch==='+'||ch==='-'){flush();negative=ch==='-';}else token+=ch;}
  if(escaped)throw Error('search_query_escape');flush();
  if(include.length+exclude.length>SEARCH_LIMITS.terms)throw Error('search_query_budget');
  return {include,exclude};
}
export class SearchIndex {
  constructor(scope,limits=SEARCH_LIMITS){this.scope=scope;this.limits=limits;this.rows=new Map();this.collections=new Map();this.pages=new Map();this.bytes=0;this.cached=null;}
  setCollections(collections){
    const next=new Map();
    for(const c of collections){if(next.has(c.collectionId)||!Array.isArray(c.orderedQuestionRefs))throw Error('collection_index_mismatch');const ids=c.orderedQuestionRefs.map(r=>r.questionId);if(new Set(ids).size!==ids.length)throw Error('collection_index_mismatch');next.set(c.collectionId,ids);}
    this.collections=next;this.cached=null;
  }
  append(page,items){
    if(!Number.isSafeInteger(page)||page<0||page>=1000||!Array.isArray(items)||items.length>1000)throw Error('search_index_invalid');
    if(this.pages.has(page))return;
    const staged=new Map();let size=0;
    for(const item of items){
      if(typeof item.searchText!=='string'||new TextEncoder().encode(item.searchText).length>this.limits.text||!Array.isArray(item.collectionIds)||typeof item.practiceEligible!=='boolean'||typeof item.stemExcerpt!=='string')throw Error('search_index_invalid');
      if(!Array.isArray(item.classificationHints)||item.classificationHints.length>64||item.classificationHints.some(t=>typeof t!=='string'||t.length>2048))throw Error('search_classification_invalid');
      if(this.rows.has(item.questionId)||staged.has(item.questionId))throw Error('search_index_duplicate');
      const {searchText,...display}=item;
      const text=searchText.toLocaleLowerCase();size+=(text.length+JSON.stringify(display).length)*2;
      if(this.bytes+size>this.limits.bytes||this.rows.size+staged.size+1>this.limits.rows)throw Error('search_index_budget');
      staged.set(item.questionId,{text,display});
    }
    if(this.bytes+size>this.limits.bytes||this.rows.size+staged.size>this.limits.rows)throw Error('search_index_budget');
    for(const [id,row] of staged)this.rows.set(id,row);
    this.bytes+=size;this.pages.set(page,[...staged.keys()]);this.cached=null;
  }
  facets(){const categories=new Set(),types=new Set();for(const {display} of this.rows.values()){types.add(display.type);for(const hint of display.classificationHints||[])if(hint.startsWith('category:'))categories.add(hint.slice(9));}return {categories:[...categories].sort(),types:[...types].sort()};}
  async query({query='',collection='',collectionIds=[],type='',category='',offset=0,limit=this.limits.page},cancel=()=>false,yieldNow=()=>new Promise(r=>setTimeout(r,0))){
    if(!Array.isArray(collectionIds)||collectionIds.some(id=>!this.collections.has(id)))throw Error('collection_index_mismatch');
    const scope=collectionIds.length?[...new Set(collectionIds)]:collection?[collection]:[];
    if(!Number.isSafeInteger(offset)||offset<0)throw Error('search_offset_invalid');
    if(!Number.isSafeInteger(limit)||limit<1||limit>(scope.length?2000:this.limits.page))throw Error('search_limit_invalid');
    const terms=parseQuery(query),key=JSON.stringify([terms,scope,type,category]);
    if(this.cached?.key!==key){
      const ids=scope.length?[...new Set(scope.flatMap(id=>{const refs=this.collections.get(id);if(!refs)throw Error('collection_index_mismatch');return refs;}))]:[...this.pages].sort((a,b)=>a[0]-b[0]).flatMap(([,ids])=>ids);
      if(!ids)throw Error('collection_index_mismatch');
      const matches=[];let n=0;
      for(const id of ids){
        if(cancel())throw Error('cancelled');
        const row=this.rows.get(id);if(!row)throw Error('collection_index_mismatch');
        if(scope.length&&!scope.some(id=>row.display.collectionIds.includes(id)))throw Error('collection_index_mismatch');
        const tags=(row.display.classificationHints||[]).filter(t=>t.startsWith('category:'));
        if((!category||(category==='unclassified'?tags.length===0:tags.includes('category:'+category)))&&(!type||row.display.type===type)&&terms.include.every(t=>row.text.includes(t))&&terms.exclude.every(t=>!row.text.includes(t)))matches.push(id);
        if(++n%1000===0)await yieldNow();
      }
      if(cancel())throw Error('cancelled');this.cached={key,matches};
    }
    if(cancel())throw Error('cancelled');
    const ids=this.cached.matches;
    const ordinals=scope.length===1?new Map(this.collections.get(scope[0]).map((id,i)=>[id,i+1])):null;
    return {items:ids.slice(offset,offset+limit).map(id=>ordinals?{...this.rows.get(id).display,collectionNumber:ordinals.get(id)}:this.rows.get(id).display),total:ids.length,offset,hasMore:offset+limit<ids.length};
  }
}
