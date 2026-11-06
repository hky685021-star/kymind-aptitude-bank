// Navigation catalog only: links do not grant installation or payment rights.
import {openBank} from './core.mjs';
import {validatePresentation} from './presentation.mjs';
const $=id=>document.getElementById(id),groups=[['civil','考公'],['accounting','会计'],['law','法律'],['other','其它题库']];
export function safeBankLink(value,base){const u=new URL(value,base);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)throw Error('题库链接无效');return u.href;}
export function renderPortal(catalog,doc=document){
  if(!catalog||!Array.isArray(catalog.banks)||catalog.banks.length>1000)throw Error('题库目录无效');
  const seen=new Set();for(const b of catalog.banks){if(typeof b.id!=='string'||typeof b.title!=='string'||!b.title||!groups.some(([id])=>id===b.group)||typeof b.href!=='string'||seen.has(b.id))throw Error('题库目录条目无效');seen.add(b.id);safeBankLink(b.href,location.href);}
  const subjects=doc.getElementById('subjects');subjects.replaceChildren();
  for(const [id,title] of groups){if(id==='other'&&!catalog.banks.some(b=>b.group===id))continue;const button=doc.createElement('button');button.textContent=title;button.setAttribute('aria-pressed','false');button.onclick=()=>{for(const b of subjects.children)b.setAttribute('aria-pressed',String(b===button));doc.getElementById('banks-panel').hidden=false;doc.getElementById('subject-title').textContent=id==='other'?title:title+'题库';const list=doc.getElementById('banks');list.replaceChildren();const banks=catalog.banks.filter(b=>b.group===id);for(const b of banks){const a=doc.createElement('a');a.className='button-link';a.textContent=b.title;a.href=safeBankLink(b.href,location.href);list.append(a);}if(!banks.length){const p=doc.createElement('p');p.textContent='暂无可用题库';p.className='muted';list.append(p);}};subjects.append(button);}
}
async function start(){
  const r=await fetch(new URL('catalog.json',import.meta.url),{cache:'no-store'});let catalog;
  if(r.ok){const text=await r.text();if(text.length>1024*1024)throw Error('题库目录过大');catalog=JSON.parse(text);}
  else if(r.status===404){const bank=await openBank(new URL('../',import.meta.url));if(!bank.root.presentation)throw Error('尚未配置题库类别，请重新构建发行或配置导航目录');const p=validatePresentation(bank.root.presentation);catalog={banks:[{id:bank.entry.bankId,group:p.group,title:p.title,href:'practice.html'}]};}
  else throw Error('读取题库目录失败：HTTP '+r.status);
  renderPortal(catalog);$('portal-status').textContent='请选择类别；不会自动进入任何题库。';
}
if(document.getElementById('subjects'))void start().catch(e=>{$('portal-status').textContent=e.message;});
