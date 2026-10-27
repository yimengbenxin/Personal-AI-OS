import type {ScopeExecution,ScopeTarget} from './scope-grant.ts';
import type {WorkItem,WorkItemReceipt} from './work-items.ts';
export type {WorkItem,WorkItemReceipt} from './work-items.ts';

export interface KeynoteTarget extends ScopeTarget {
  kind:'keynote-local';app_bundle_id:'com.apple.iWork.Keynote';
  document_id:string;file_identity:string;file_url:string;display_name:string;
}
export interface PresentationImage extends ScopeTarget {
  image_ref:string;sha256:string;mime:'image/jpeg';width:number;height:number;
  window_id:number;captured_at:string;expires_at:string;
}
export interface SlideElement {
  element_id:string;kind:'text'|'table_cell';text:string;text_sha256:string;
  bbox:[number,number,number,number];text_style_ref:string;
}
export interface SlideSnapshot {
  version:1;target:KeynoteTarget;deck_revision:string;captured_at:string;clock_uncertainty_ms:number;
  presentation_id:string;mode:'editing'|'slideshow';slide_id:string;slide_number:number;
  page_source:'slideshow_state'|'document_selection';
  cross_check:'matched'|'unavailable'|'ambiguous';image:PresentationImage|null;elements:SlideElement[];
}
/** All-page text from the exact native document. Does not assert that any page is currently displayed. */
export interface PresentationOutline {
  version:1;target:KeynoteTarget;deck_revision:string;captured_at:string;source:'document_tree';
  slides:{slide_id:string;slide_number:number;elements:SlideElement[]}[];
}
export interface TextEdit {
  work_item_id:string;slide_id:string;slide_number:number;element_id:string;
  op:'replace_text'|'append_paragraph';before_text_sha256:string;after_text:string;basis_refs:string[];
}
export interface TextPlan {
  version:1;plan_id:string;revision:number;plan_sha256:string;target:KeynoteTarget;
  scope_session_id:string;base_deck_revision:string;workflow:'local_review_then_project';
  edits:TextEdit[];preview_items:string[];
}
export interface MacEditResult {
  version:1;operation_id:string;target:KeynoteTarget;plan_sha256:string;revision:number;
  items:WorkItem[];checks:TextReadBack[];file_sha256?:string;saved_at?:string;
  review_status:'awaiting_owner';error_code?:string;
}
export interface TextReadBack {
  work_item_id:string;before_text_sha256:string;after_text_sha256:string;
  saved_at:string;read_back_at:string;evidence_ref:string;
}
export type PresentationAction = 'presentation_snapshot'|'presentation_apply_text'|'presentation_edit_status';
export interface PresentationInputs {
  presentation_snapshot:{target:KeynoteTarget;shared_window_id:number|null};
  presentation_apply_text:{target:KeynoteTarget;plan:TextPlan;execution:ScopeExecution;idempotency_key:string};
  presentation_edit_status:{target:KeynoteTarget;operation_id:string};
}
/** Native MCP result: structuredContent is always receipt v1; image bytes remain outside JSON facts. */
export interface PresentationResult {
  structuredContent:WorkItemReceipt;
  content:({type:'text';text:string}|{type:'image';mimeType:'image/jpeg';data:string})[];
}
