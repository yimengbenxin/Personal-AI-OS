import {readFileSync} from 'node:fs';
import {Ajv} from 'ajv';
import type {PresentationAction,PresentationInputs,PresentationResult,KeynoteTarget,SlideSnapshot,PresentationOutline} from '../../../../../../capability/contracts/presentation.ts';
import {check} from '../contracts.ts';
import type {MeetingFrame,MeetingWord} from './observations.ts';

export type MeetingTool='read_deck'|'locate_region'|'plan_text'|'apply_text'|'edit_status';
/** Product identities injected from admission. Public hook api_request_id is an opaque provider attempt. */
export interface MeetingContext {run_id:string;session_id:string;tool_call_id:string}
export interface MeetingSelection {target:KeynoteTarget;shared_window_id:number|null;origin_processed_event_id:string;session_id:string;attachment_grant_id:string}
export interface MeetingWorkspace extends MeetingSelection {principal_id:string;scope_session_id:string;glasses_device_id:string}
export interface SnapshotRecord {ref:string;principal_id:string;scope_session_id:string;snapshot:SlideSnapshot}
export interface PageRecord {ref:string;principal_id:string;scope_session_id:string;snapshot_ref:string;
  page:PresentationOutline['slides'][number]&Omit<PresentationOutline,'slides'|'version'>}
export interface MeetingPorts {
  invoke<A extends PresentationAction>(binding:{principal_id:string;target_device_id:string},action:A,args:PresentationInputs[A],signal:AbortSignal):Promise<PresentationResult>;
  frame(principal:string,frame:MeetingFrame,signal:AbortSignal):Promise<Buffer>;
  contactSheet(frames:Buffer[],slide:Buffer,signal:AbortSignal):Promise<Buffer>;
  vision(image:Buffer,prompt:{prompt:string;response_schema:Record<string,unknown>},signal:AbortSignal,context:MeetingContext):Promise<string>;
  capture?(workspace:MeetingWorkspace,active:boolean):Promise<void>;
  /** Existing task admission, carrying the original owner file request. Other speech is quoted evidence only. */
  discuss?(workspace:MeetingWorkspace,word:MeetingWord):Promise<void>;
  canDiscuss?(workspace:MeetingWorkspace):Promise<boolean>;
}
const schemas=JSON.parse(readFileSync(new URL('../../../../../../capability/packages/meeting-assistant/server/schemas.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:false});const validators=new Map<string,ReturnType<Ajv['compile']>>();
for(const [name,schema] of Object.entries(schemas))validators.set(name,ajv.compile(schema as object));
export function validateMeetingCall(tool:string,args:unknown):asserts tool is MeetingTool {
  check(validators.get(tool)?.(args),'MEETING_INPUT_INVALID');
}
