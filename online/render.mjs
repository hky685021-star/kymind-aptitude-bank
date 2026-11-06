// Portable readonly Tiptap renderer; accepts a scoped media capability, not URLs.
export async function renderContent(body,occurrences,loadImage,signal,objectUrls,options={}){
  if(body?.format!=='tiptap-portable-v1'||body.doc?.type!=='doc')throw Error('body_invalid');
  let count=0;const images=new Map(occurrences.map(o=>[o.occurrenceId,o]));
  function element(tag,text){const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;}
  async function node(n,depth){
    if(++count>50000||depth>64)throw Error('body_budget');
    if(n.type==='text'){let result=document.createTextNode(n.text||'');for(const mark of n.marks||[]){const tag={bold:'strong',italic:'em',underline:'u',strike:'s',code:'code',superscript:'sup',subscript:'sub'}[mark.type];if(!tag)throw Error('body_mark_unsupported');const wrapper=element(tag);wrapper.append(result);result=wrapper;}return result;}
    if(n.type==='hardBreak')return element('br');
    if(n.type==='inlineMath'||n.type==='blockMath'){const latex=n.attrs?.latex;if(typeof latex!=='string'||latex.length>8192||/\\(?:href|url|includegraphics|html|style|class|cssId)\b/.test(latex))throw Error('math_unsafe');const block=n.type==='blockMath',e=element(block?'div':'span',(block?'\\[':'\\(')+latex+(block?'\\]':'\\)'));e.className='math';return e;}
    if(n.type==='questionImage'){const o=images.get(n.attrs?.occurrenceId);if(!o)throw Error('media_occurrence_missing');const img=element('img');img.alt=o.alt||'题目图片';img.loading='lazy';const load=async()=>{if(signal?.aborted)return;const blob=await loadImage(o,signal);if(signal?.aborted)return;const url=URL.createObjectURL(blob);objectUrls.push(url);img.src=url;};if(options.deferImage)options.deferImage(img,async()=>{try{await load();}catch(e){if(!signal?.aborted)img.replaceWith(element('span','图片加载失败：'+e.message));}});else await load();return img;}
    const tags={doc:'div',paragraph:'p',heading:'h3',bulletList:'ul',orderedList:'ol',listItem:'li',blockquote:'blockquote',table:'table',tableRow:'tr',tableCell:'td',tableHeader:'th'};
    if(!tags[n.type])throw Error('body_node_unsupported');const e=element(tags[n.type]);
    if(n.type==='tableCell'||n.type==='tableHeader'){for(const [attr,key]of [['colSpan','colspan'],['rowSpan','rowspan']]){const value=n.attrs?.[key];if(Number.isInteger(value)&&value>0&&value<=50)e[attr]=value;}}
    for(const child of n.content||[])e.append(await node(child,depth+1));return e;
  }return node(body.doc,0);
}
