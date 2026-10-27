/** Preserve public MCP content and legacy MEDIA attachments without inferring receipt facts. */
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
export type MediaBlock=CallToolResult['content'][number];
export function mediaContent(raw:unknown):MediaBlock[]{
  if(typeof raw==='string'){
    try{raw=JSON.parse(raw);}catch{return (raw as string).split('\n').filter(line=>line.startsWith('MEDIA:')).map(text=>({type:'text',text}));}
  }
  if(!raw||typeof raw!=='object')return [];
  const row=raw as {content?:MediaBlock[];result?:unknown};
  const blocks=Array.isArray(row.content)?row.content.filter(block=>['image','audio','resource','resource_link'].includes(block.type)||
    block.type==='text'&&typeof block.text==='string'&&block.text.split('\n').some(line=>line.startsWith('MEDIA:'))):[];
  return [...structuredClone(blocks),...(typeof row.result==='string'?mediaContent(row.result):[])];
}
export function withMedia<T extends {content:{type:'text';text:string}[]}>(wire:T,raw:unknown):Omit<T,'content'>&{content:MediaBlock[]}{
  const blocks=mediaContent(raw),text=blocks.filter(block=>block.type==='text').map(block=>block.text).join('\n');
  return {...wire,content:[...wire.content.map((block,index)=>index===0&&text?{...block,text:block.text+'\n'+text}:block),
    ...blocks.filter(block=>block.type!=='text')]};
}
