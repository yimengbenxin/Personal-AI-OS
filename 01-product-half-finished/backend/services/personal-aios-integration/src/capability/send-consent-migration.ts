import {canonical,digest} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import {packageCatalog,type PackageTool} from './packages.ts';
import {SEND_CONSENTS} from './send-identity.ts';
import {channelAddress,wechatRecipient,type SendDirectory} from '../../../../../../capability/contracts/send-recipient.ts';

const wechatKinds:Record<string,string>={wechat_reply_text:'message.text',wechat_send_text:'message.text',
  wechat_reply:'message.text',wechat_file_send:'message.file',wechat_send_file:'message.file'};
const catalog=()=>packageCatalog({enabled:['wechat-mac','messaging'],gateway:['wechat-mac','messaging']});
function legacyKind(task:string,recipient:string,tools:Map<string,PackageTool>):string {
  if(wechatKinds[task]){
    if(recipient.includes(':')&&!/^(?:wechat|weixin):/iu.test(recipient.trim()))throw new Error('SEND_CHANNEL_AMBIGUOUS');
    const declared=[...tools.values()].some(tool=>tool.send_consent?.recipient==='wechat'&&tool.send_consent.kind===wechatKinds[task]);
    if(declared)return wechatKinds[task]!;
    throw new Error('SEND_KIND_AMBIGUOUS');
  }
  const match=/^send_message:([^:]+):(react|unreact)$/u.exec(task);
  if(match&&recipient.startsWith(match[1]+':')){
    const kind=match[2]==='react'?'message.reaction':'message.reaction_remove';
    if([...tools.values()].some(tool=>tool.send_consent?.kinds?.[match[2]!]===kind))return kind;
  }
  // Legacy send_message:*:send did not distinguish text from attachments. It cannot imply either new grant.
  throw new Error('SEND_KIND_AMBIGUOUS');
}

/** Add canonical records, never mutate a legacy record. A per-source receipt makes replays idempotent. */
export async function migrateSendConsents(storage:StoragePort,principal:string,directory:SendDirectory,tools=catalog()) {
  const result={version:1,status:'completed',migrated:0,already_migrated:0,
    unmigrated:[] as {key:string;task_type:unknown;recipient:unknown;reason:string}[]};
  for(const key of await storage.list('effect-consents')){
    const record=JSON.parse(Buffer.from(await storage.read('effect-consents',key)).toString('utf8'));
    if(record.kind!=='send'||record.principal_id!==principal||record.run_id!==undefined||record.tool_call_id!==undefined||record.send_consent_projection===1)continue;
    try {
      const original={principal_id:principal,kind:'send',task_type:record.task_type,recipient:record.recipient};
      if(digest(original)!==key||typeof record.task_type!=='string'||typeof record.recipient!=='string')throw new Error('SEND_LEGACY_SCOPE_INVALID');
      const task_type=legacyKind(record.task_type,record.recipient,tools);
      const recipient=wechatKinds[record.task_type]?wechatRecipient(record.recipient,directory).recipient:channelAddress(record.recipient);
      const scope={principal_id:principal,kind:'send',task_type,recipient},target=digest(scope);
      const receiptKey=digest([principal,key]);
      try {
        const receipt=JSON.parse(Buffer.from(await storage.read('send-consent-migrations-v1',receiptKey)).toString('utf8'));
        if(receipt.target!==target)throw new Error('SEND_KIND_CONTRACT_CHANGED');
        result.already_migrated++;continue;
      }catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      await storage.publish(SEND_CONSENTS,target,Buffer.from(canonical({...record,...scope})));
      await storage.publish('send-consent-migrations-v1',receiptKey,Buffer.from(canonical({source:key,target})));
      result.migrated++;
    }catch(error){
      const reason=error instanceof Error?error.message:'';
      if(!/^SEND_(?:RECIPIENT_(?:AMBIGUOUS|UNRESOLVED)|CHANNEL_AMBIGUOUS|KIND_AMBIGUOUS|LEGACY_SCOPE_INVALID)$/u.test(reason))throw error;
      result.unmigrated.push({key,task_type:record.task_type,recipient:record.recipient,reason});
    }
  }
  if(result.unmigrated.length)result.status='completed_with_unmigrated';
  return result;
}
