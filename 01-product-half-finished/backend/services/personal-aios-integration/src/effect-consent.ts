import {canonical,check,digest,id,ownerActionGrant,type ProcessedEvent} from './contracts.ts';
import type {AdmissionEntry,RunAdmission} from './admission.ts';
import type {StoragePort} from './storage.ts';
import type {ToolCall} from './runtime.ts';
import type {OwnerConfirmation} from './hermes-client.ts';
import {nativeApprovalId} from './voiceprint/confirmation.ts';

/** What the gated tool result reports: the owner's card decision and how far the server keeps it. */
export const effectConfirmationReceipt=(record:Record<string,unknown>,remembered:boolean,reused:boolean)=>({confirmation_id:record.confirmation_id,
  confirmation_evidence:{actor_type:'authenticated_owner_principal',physical_actor:'unknown',card_rendering:'unknown'},
  decision_status:'resolved',decision:'approved',decision_source:'effect_consent_record',
  choice:'once',confirmed_by:record.confirmed_by??record.principal_id,surface:record.surface??null,confirmed_at:record.confirmed_at,
  decided_by:record.confirmed_by??record.principal_id,decided_at:record.confirmed_at,remembered,reused});

/** One first-send and per-request effect authority; existing storage owns every decision. */
export async function effectConsent(ports:{admission:Pick<RunAdmission,'find'>;storage:StoragePort;
  ownerOrigin:(d:ProcessedEvent)=>Promise<ProcessedEvent|undefined>;paymentSource:(run:string)=>{ride_allowed:boolean}},
  context:ToolCall['context'],effect:Record<string,unknown>,approved=false,rideOk=false,approvalRequestId='',confirmation?:OwnerConfirmation,forceOnce=false){
  id(context.run_id);id(context.session_id);id(context.tool_call_id);
  const entry=ports.admission.find(context.run_id,context.session_id);
  check(entry&&!['completed','cancelled','expired','failed'].includes(entry.record.state),'RUN_BINDING_REQUIRED',409);
  return decideEffectConsent(ports,entry,context,effect,approved,rideOk,approvalRequestId,confirmation,forceOnce);
}

/** A platform-frozen call outlives its native run. The card retains its original admission, never a new model call. */
export async function confirmFrozenEffect(ports:Parameters<typeof effectConsent>[0],entry:AdmissionEntry,
  context:ToolCall['context'],effect:Record<string,unknown>,rideOk:boolean,requestId:string,confirmation:OwnerConfirmation,forceOnce=false){
  check(entry.record.run_id===context.run_id&&entry.record.session_id===context.session_id,'RUN_BINDING_REQUIRED',409);
  return decideEffectConsent(ports,entry,context,effect,true,rideOk,requestId,confirmation,forceOnce);
}

async function decideEffectConsent(ports:Parameters<typeof effectConsent>[0],entry:AdmissionEntry,
  context:ToolCall['context'],effect:Record<string,unknown>,approved:boolean,rideOk:boolean,approvalRequestId:string,confirmation?:OwnerConfirmation,forceOnce=false){
  const owner=(await ownerActionGrant(entry.d,d=>ports.ownerOrigin(d))).length>0;
  const approvedRide=rideOk&&effect.kind==='external'&&effect.requested===true&&ports.paymentSource(context.run_id).ride_allowed;
  check(owner||approvedRide,'OWNER_REQUEST_REQUIRED',403);
  check(Object.keys(effect).every(k=>['kind','recipient','task_type','requested','summary'].includes(k))&&
    (effect.summary===undefined||typeof effect.summary==='string'&&effect.summary.length<=240)&&
    ['read','file_edit','send','login','delete','external'].includes(String(effect.kind))&&typeof effect.requested==='boolean'&&
    typeof effect.task_type==='string'&&effect.task_type.length>0&&effect.task_type.length<=100&&
    (effect.kind!=='send'||typeof effect.recipient==='string'&&effect.recipient.trim().length>0&&effect.recipient.length<=200),
    'EFFECT_CLASSIFICATION_REQUIRED');
  const sending=effect.kind==='send',persistent=sending&&effect.requested&&!forceOnce,scope={principal_id:entry.d.principal_id,kind:effect.kind,task_type:effect.task_type,
    ...(sending?{recipient:effect.recipient}:{}),...(!persistent?{run_id:context.run_id,tool_call_id:context.tool_call_id}:{})},key=digest(scope);
  const required=forceOnce||sending||!effect.requested;
  if(!required)return {status:'allowed'};
  const parse=(bytes:Uint8Array)=>JSON.parse(Buffer.from(bytes).toString('utf8')) as Record<string,unknown>;
  try{return {status:'allowed',approval:effectConfirmationReceipt(parse(await ports.storage.read('effect-consents',key)),persistent,true)};}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  if(!approved)return {status:'confirmation_required',scope};
  check(confirmation&&confirmation.confirmed_by===entry.d.principal_id&&
    confirmation.confirmation_id===nativeApprovalId(entry.d.principal_id,context.run_id,approvalRequestId)&&
    typeof confirmation.surface?.device_id==='string'&&typeof confirmation.surface?.device_type==='string'&&
    typeof confirmation.confirmed_at==='string'&&Number.isFinite(Date.parse(confirmation.confirmed_at)),
    'EFFECT_CONFIRMATION_RECEIPT_REQUIRED',409);
  const saved=parse(await ports.storage.publish('effect-consents',key,Buffer.from(canonical({...scope,confirmation_id:confirmation.confirmation_id,
    confirmed_by:confirmation.confirmed_by,surface:confirmation.surface,confirmed_at:confirmation.confirmed_at}))));
  return {status:'allowed',approval:effectConfirmationReceipt(saved,persistent,false)};
}
