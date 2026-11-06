import {SearchIndex} from './search-index.mjs';
let index,generation=0;
self.onmessage=async({data:m})=>{
  try{
    if(m.kind==='init'){generation++;index=new SearchIndex(m.scope);index.setCollections(m.collections);}
    else if(m.kind==='append'){index.append(m.page,m.items);}
    else if(m.kind==='cancel'){generation++;return;}
    else if(m.kind==='facets'){self.postMessage({id:m.id,result:index.facets()});return;}
    else if(m.kind==='query'){
      const token=++generation,result=await index.query(m.input,()=>token!==generation);
      if(token!==generation)return;
      self.postMessage({id:m.id,result});return;
    }else throw Error('search_message_invalid');
    self.postMessage({id:m.id,result:true});
  }catch(error){self.postMessage({id:m.id,error:error.message});}
};
