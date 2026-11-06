// Display metadata only. Never an entitlement, grading or classification authority.
export function validatePresentation(value){
  if(!value||typeof value.group!=='string'||!/^\w[\w-]{0,63}$/.test(value.group)||typeof value.groupTitle!=='string'||!value.groupTitle.trim()||value.groupTitle.length>100||typeof value.title!=='string'||!value.title.trim()||value.title.length>200||!Array.isArray(value.categories)||value.categories.length>2000)throw Error('bank_presentation_invalid');
  const nodes=new Map();
  for(const c of value.categories){if(!c||typeof c.code!=='string'||!/^[a-z][a-z0-9.-]{0,127}$/.test(c.code)||typeof c.title!=='string'||!c.title.trim()||c.title.length>200||!(c.parent===null||typeof c.parent==='string')||nodes.has(c.code))throw Error('bank_category_invalid');nodes.set(c.code,c);}
  for(const c of nodes.values()){const seen=new Set([c.code]);let p=c.parent;while(p!==null){if(!nodes.has(p)||seen.has(p))throw Error('bank_category_parent_invalid');seen.add(p);p=nodes.get(p).parent;}}
  return value;
}
export function categoryLabels(value){return Object.fromEntries(validatePresentation(value).categories.map(c=>[c.code,c.title]));}
