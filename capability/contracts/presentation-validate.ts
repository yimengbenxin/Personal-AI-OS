import {readFileSync} from 'node:fs';
import {canonical,check,digest,sha256} from './json.ts';
import type {PresentationAction,PresentationInputs,TextPlan,SlideSnapshot,MacEditResult,PresentationOutline} from './presentation.ts';

export const presentationSchema=JSON.parse(readFileSync(new URL('../../integrations/contracts/presentation.v1.schema.json',import.meta.url),'utf8'));
export const presentationTools=JSON.parse(readFileSync(new URL('../../integrations/contracts/presentation-tools.v1.json',import.meta.url),'utf8')).tools;
export interface DesktopTargetBinding {principal_id:string;target_device_id:string}

/** Hash is canonical UTF-8 JSON without plan_sha256, with recursively sorted object keys. */
export function textPlanHash(value:Omit<TextPlan,'plan_sha256'>|TextPlan):string {
  const {plan_sha256:_,...body}=value as TextPlan;return digest(body);
}
/** Package-local callers supply their own installed schema compiler. */
export interface PresentationCompiler {
  addSchema(schema:object):unknown;
  compile(schema:object):(value:unknown)=>boolean;
}
export interface PresentationValidators {
  validateTextPlan(value:unknown):asserts value is TextPlan;
  validatePresentationInput<A extends PresentationAction>(action:A,value:unknown,binding:DesktopTargetBinding,now?:number):asserts value is PresentationInputs[A];
  validateSlideSnapshot(value:unknown):asserts value is SlideSnapshot;
  validateMacEditResult(value:unknown):asserts value is MacEditResult;
  validatePresentationOutline(value:unknown):asserts value is PresentationOutline;
}
export function createPresentationValidators(compiler:PresentationCompiler):PresentationValidators {
  compiler.addSchema(presentationSchema);
  const validate=(name:string)=>compiler.compile({$ref:`urn:paios:presentation:1#/$defs/${name}`});
  const inputs=new Map<string,(value:unknown)=>boolean>(presentationTools.map((tool:{name:string;inputSchema:object})=>[tool.name,compiler.compile(tool.inputSchema)] as const));
  const snapshot=validate('snapshot'),plan=validate('plan'),result=validate('edit_result');
  const outline=compiler.compile(JSON.parse(readFileSync(new URL('../../integrations/contracts/presentation-outline.v1.schema.json',import.meta.url),'utf8')));
  function validateTextPlan(value:unknown):asserts value is TextPlan {
    check(plan(value),'PRESENTATION_PLAN_INVALID');
    const typed=value as TextPlan;
    check(typed.plan_sha256===textPlanHash(typed),'PRESENTATION_PLAN_HASH_MISMATCH');
    check(new Set(typed.edits.map(edit=>edit.work_item_id)).size===typed.edits.length&&
      new Set(typed.edits.map(edit=>`${edit.slide_id}:${edit.element_id}`)).size===typed.edits.length&&
      typed.preview_items.length===typed.edits.length,'PRESENTATION_PLAN_ITEMS_INVALID');
  }
  function validatePresentationInput<A extends PresentationAction>(action:A,value:unknown,binding:DesktopTargetBinding,now=Date.now()):asserts value is PresentationInputs[A] {
    const validate=inputs.get(action);check(validate?.(value),'PRESENTATION_INPUT_INVALID');
    const args=value as PresentationInputs[PresentationAction];
    check(args.target.target_device_id===binding.target_device_id,'PRESENTATION_DEVICE_MISMATCH',403);
    if(action==='presentation_apply_text'){
      const typed=value as PresentationInputs['presentation_apply_text'];validateTextPlan(typed.plan);
      check(canonical(typed.target)===canonical(typed.plan.target),'PRESENTATION_TARGET_MISMATCH',403);
      const permit=typed.execution;
      check(permit.principal_id===binding.principal_id&&permit.target_device_id===binding.target_device_id&&
        permit.target_id===typed.target.target_id&&permit.scope_session_id===typed.plan.scope_session_id&&
        permit.plan_sha256===typed.plan.plan_sha256,'PRESENTATION_EXECUTION_MISMATCH',403);
      check(now<Date.parse(permit.valid_until),'PRESENTATION_EXECUTION_EXPIRED',409);
    }
  }
  function validateSlideSnapshot(value:unknown):asserts value is SlideSnapshot {
    check(snapshot(value),'PRESENTATION_SNAPSHOT_INVALID');const typed=value as SlideSnapshot;
    check(new Set(typed.elements.map(item=>item.element_id)).size===typed.elements.length,'PRESENTATION_ELEMENTS_DUPLICATE');
    for(const item of typed.elements)check(item.bbox[0]<item.bbox[2]&&item.bbox[1]<item.bbox[3]&&
      sha256(item.text)===item.text_sha256,'PRESENTATION_ELEMENT_INVALID');
    if(typed.image)check(typed.image.target_id===typed.target.target_id&&typed.image.target_device_id===typed.target.target_device_id&&
      Date.parse(typed.image.expires_at)>Date.parse(typed.image.captured_at),'PRESENTATION_IMAGE_BINDING_INVALID');
  }
  function validateMacEditResult(value:unknown):asserts value is MacEditResult {
    check(result(value),'PRESENTATION_RESULT_INVALID');const typed=value as MacEditResult;
    check(new Set(typed.items.map(item=>item.id)).size===typed.items.length&&
      new Set(typed.checks.map(item=>item.work_item_id)).size===typed.checks.length,'PRESENTATION_RESULT_ITEMS_INVALID');
    for(const item of typed.items)if(item.state==='succeeded'){
      const proof=typed.checks.find(row=>row.work_item_id===item.id);
      check(proof&&typed.file_sha256&&typed.saved_at&&item.effect_refs.includes(proof.evidence_ref)&&
        Date.parse(proof.read_back_at)>=Date.parse(proof.saved_at),'PRESENTATION_READ_BACK_REQUIRED');
    }
  }
  function validatePresentationOutline(value:unknown):asserts value is PresentationOutline {
    check(outline(value),'PRESENTATION_OUTLINE_INVALID');const typed=value as PresentationOutline;
    check(new Set(typed.slides.map(s=>s.slide_id)).size===typed.slides.length&&new Set(typed.slides.map(s=>s.slide_number)).size===typed.slides.length,'PRESENTATION_OUTLINE_DUPLICATE');
    for(const page of typed.slides){
      check(new Set(page.elements.map(e=>e.element_id)).size===page.elements.length,'PRESENTATION_ELEMENTS_DUPLICATE');
      for(const e of page.elements)check(e.bbox[0]<e.bbox[2]&&e.bbox[1]<e.bbox[3]&&sha256(e.text)===e.text_sha256,'PRESENTATION_ELEMENT_INVALID');
    }
  }
  return {validateTextPlan,validatePresentationInput,validateSlideSnapshot,validateMacEditResult,validatePresentationOutline};
}
