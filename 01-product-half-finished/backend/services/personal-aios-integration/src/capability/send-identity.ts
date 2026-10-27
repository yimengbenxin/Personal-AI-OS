import {check} from '../contracts.ts';
import {channelAddress} from '../../../../../../capability/contracts/send-recipient.ts';
import type {PackageTool} from './packages.ts';
import type {GatewayCall} from './gateway.ts';

export interface SendPolicy {recipient:'wechat'|'channel';kind?:string;kinds?:Record<string,string>}
export interface SendIdentity {recipient:string;task_type:string;legacy?:{recipient:string;task_type:string}[]}
export const SEND_CONSENTS='send-consents-v1';
const wechatTasks:Record<string,string[]>={text:['wechat_reply_text','wechat_send_text','wechat_reply'],
  file:['wechat_file_send','wechat_send_file']};

/** Only a catalog policy and authenticated native preparation can choose the remembered scope. */
export function sendIdentity(tool:PackageTool,call:GatewayCall&{prepared?:{message_kind?:string;legacy_recipients?:string[]}}):SendIdentity {
  const policy=tool.send_consent,prepared=call.prepared;
  check(policy,'SEND_KIND_UNRESOLVED',409);
  check(prepared?.target,'SEND_RECIPIENT_UNRESOLVED',409);
  const kind=policy.kind??policy.kinds?.[prepared.message_kind??''];
  check(kind,'SEND_KIND_UNRESOLVED',409);
  const recipient=channelAddress(prepared.target);
  if(policy.recipient==='wechat')check(/^wechat:(?:id|name):.+/u.test(recipient),'SEND_RECIPIENT_UNRESOLVED',409);
  const variant=Object.entries(wechatTasks).find(([variant])=>kind===`message.${variant}`)?.[0];
  return {recipient,task_type:kind,...(policy.recipient==='wechat'&&variant?{legacy:
    (prepared.legacy_recipients??[]).flatMap(recipient=>wechatTasks[variant]!.map(task_type=>({recipient,task_type})))}:{})};
}
