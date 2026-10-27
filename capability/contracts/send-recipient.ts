import {readFileSync} from 'node:fs';
const {decoration_ranges:ranges}=JSON.parse(readFileSync(new URL('./send-recipient-normalization.v1.json',import.meta.url),'utf8')) as {decoration_ranges:[number,number][]};
/** Channel directory evidence is supplied by the platform, never by a tool argument. */
export interface SendContact {id?:string;name:string}
export interface SendDirectory {platforms?:Record<string,SendContact[]>}

/** Match the WeChat app card: dots, whitespace and emoji decoration do not identify a person. */
export function wechatName(value:string):string {
  return [...value.normalize('NFC')].filter(char=>!ranges.some(([lo,hi])=>char.codePointAt(0)!>=lo&&char.codePointAt(0)!<=hi)).join('');
}
export function channelAddress(value:string):string {
  const split=value.indexOf(':');
  if(split<1)throw new Error('SEND_RECIPIENT_UNRESOLVED');
  const channel=value.slice(0,split).trim().toLowerCase(),address=value.slice(split+1).trim();
  if(!address)throw new Error('SEND_RECIPIENT_UNRESOLVED');
  if(channel==='email'){
    const at=address.lastIndexOf('@');
    if(at<1||!address.slice(at+1).includes('.')||/[\s,;]/u.test(address))throw new Error('SEND_RECIPIENT_UNRESOLVED');
    // Local parts may be case-sensitive. Do not strip +tags, dots or other mailbox syntax.
    return `email:${address.slice(0,at)}@${address.slice(at+1).toLowerCase()}`;
  }
  return `${channel}:${channel==='slack'?address.replace(/^user:/u,''):address}`;
}
/** A unique directory row is required even for display-only channels. Normalisation is not proof of identity. */
export function wechatRecipient(reference:string,directory:SendDirectory):{recipient:string;legacy_recipients:string[]} {
  const value=reference.trim().replace(/^(?:wechat|weixin):/iu,'').trim();
  const rows=directory.platforms?.wechat??directory.platforms?.weixin??[];
  const explicit=value.startsWith('id:')?value.slice(3):value;
  const byId=rows.filter(row=>row.id===explicit);
  const matches=byId.length?byId:rows.filter(row=>wechatName(row.name)===wechatName(value.replace(/^name:/u,'')));
  if(matches.length!==1)throw new Error(matches.length?'SEND_RECIPIENT_AMBIGUOUS':'SEND_RECIPIENT_UNRESOLVED');
  const row=matches[0]!,name=wechatName(row.name);
  if(!name&&!row.id)throw new Error('SEND_RECIPIENT_UNRESOLVED');
  const uniqueName=rows.filter(other=>wechatName(other.name)===name).length===1;
  return {recipient:`wechat:${row.id?'id:'+row.id:'name:'+name}`,
    legacy_recipients:[...new Set([...(row.id?[`wechat:${row.id}`]:[]),
      ...(uniqueName?[`wechat:${row.name}`,`wechat:${name}`]:[])])]};
}
