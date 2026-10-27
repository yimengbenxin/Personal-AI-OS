import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';
import {canonical,check,sha256} from '../../../services/personal-aios-integration/src/contracts.ts';
import {admitReceipt} from '../../../services/personal-aios-integration/src/capability/receipt.ts';
import {unknown,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';
import {validateSlideSnapshot,validateMacEditResult,validatePresentationOutline} from './presentation-validate.ts';
import type {PresentationAction,PresentationInputs,PresentationResult} from '../../../../../capability/contracts/presentation.ts';

/** Native failures retain uncertainty. The ordinary desktop success wrapper must not qualify these. */
export function presentationResult(action:PresentationAction,args:PresentationInputs[PresentationAction],result:CallToolResult):PresentationResult {
  const uncertain=(code:string)=>to_mcp_result(unknown({status:{reason_code:code},
    unknowns:[{about:args.target.target_id,why:code}],next:{retry:'after_check',check_with:'edit_status'}})) as unknown as PresentationResult;
  if(result.isError){
    const code=(result.structuredContent?.error as {code?:unknown}|undefined)?.code;
    return uncertain(typeof code==='string'&&/^[A-Z_]{1,100}$/u.test(code)?code:'PRESENTATION_TRANSPORT_UNKNOWN');
  }
  const body=admitReceipt(result.structuredContent);
  try{
    check(result.content.every(block=>block.type==='text'||block.type==='image'&&block.mimeType==='image/jpeg'),'PRESENTATION_CONTENT_INVALID');
    // Unknown may contain already-saved pages. Their target/audit claims need the same binding checks.
    if(['succeeded','partial','accepted','running'].includes(body.status.state)||body.effects.length||body.work_items?.length||
      body.content.some(row=>row.key===(action==='presentation_snapshot'?'slide_snapshot':'edit_result'))){
      if(action==='presentation_snapshot'){
        const value=JSON.parse(body.content.find(row=>row.key==='slide_snapshot')!.text);validateSlideSnapshot(value);
        check(canonical(value.target)===canonical(args.target),'PRESENTATION_TARGET_MISMATCH');
        const outline=body.content.find(row=>row.key==='deck_outline');
        if(outline){const tree=JSON.parse(outline.text);validatePresentationOutline(tree);
          check(canonical(tree.target)===canonical(value.target)&&tree.deck_revision===value.deck_revision&&
            tree.captured_at===value.captured_at,'PRESENTATION_OUTLINE_BINDING_INVALID');}
        if(value.image){
          const image=result.content.find(row=>row.type==='image');
          check(image?.type==='image'&&image.mimeType==='image/jpeg'&&sha256(Buffer.from(image.data,'base64'))===value.image.sha256,'PRESENTATION_IMAGE_INVALID');
          const shared=(args as PresentationInputs['presentation_snapshot']).shared_window_id;
          if(value.cross_check==='matched')check(shared===value.image.window_id,'PRESENTATION_WINDOW_MISMATCH');
        }
      }else{
        const value=JSON.parse(body.content.find(row=>row.key==='edit_result')!.text);validateMacEditResult(value);
        check(canonical(value.target)===canonical(args.target),'PRESENTATION_TARGET_MISMATCH');
        if(action==='presentation_apply_text')check(value.plan_sha256===(args as PresentationInputs['presentation_apply_text']).plan.plan_sha256,'PRESENTATION_PLAN_HASH_MISMATCH');
        else check(value.operation_id===(args as PresentationInputs['presentation_edit_status']).operation_id,'PRESENTATION_OPERATION_MISMATCH');
      }
    }
    return {...result,structuredContent:body,content:result.content as PresentationResult['content']};
  }catch{return uncertain('PRESENTATION_RECEIPT_BINDING_INVALID');}
}
