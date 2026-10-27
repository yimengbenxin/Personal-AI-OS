import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {presentationResult} from '../src/presentation-relay.ts';
import {succeeded,effect,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';
import {sha256} from '../../../services/personal-aios-integration/src/contracts.ts';
import type {CallToolResult} from '@modelcontextprotocol/sdk/types.js';

const demo=JSON.parse(readFileSync(new URL('../../../../../capability/packages/meeting-assistant/tests/demo.json',import.meta.url),'utf8'));
const args={target:demo.snapshot.target,shared_window_id:42};
function native(snapshot:any,image?:Buffer):CallToolResult {
  const result=to_mcp_result(succeeded({content:[{key:'slide_snapshot',text:JSON.stringify(snapshot),provenance:'observed'}]})) as unknown as CallToolResult;
  if(image)result.content.push({type:'image',mimeType:'image/jpeg',data:image.toString('base64')});return result;
}
test('paired snapshot image bytes remain intact with a device-bound reference and hash',()=>{
  const jpeg=Buffer.from('fixture-jpeg-bytes'),snapshot=structuredClone(demo.snapshot);
  snapshot.image.sha256=sha256(jpeg);snapshot.cross_check='matched';
  const wire=native(snapshot,jpeg),result=presentationResult('presentation_snapshot',args,wire);
  assert.equal((result.structuredContent as any).status.state,'succeeded');assert.deepEqual(result.content,wire.content);
});
test('wrong target, image bytes, shared window or missing payload cannot claim snapshot success',()=>{
  const jpeg=Buffer.from('fixture-jpeg-bytes'),snapshot=structuredClone(demo.snapshot);snapshot.image.sha256=sha256(jpeg);
  for(const change of [(s:any)=>{s.target.document_id='other';},(s:any)=>{s.image.target_device_id='other';},
    (s:any)=>{s.image.sha256='0'.repeat(64);},(s:any)=>{s.cross_check='matched';s.image.window_id=43;}]){
    const value=structuredClone(snapshot);change(value);
    const result=presentationResult('presentation_snapshot',args,native(value,jpeg));
    assert.equal((result.structuredContent as any).status.state,'unknown');
  }
  const result=presentationResult('presentation_snapshot',args,to_mcp_result(succeeded()) as unknown as CallToolResult);
  assert.equal((result.structuredContent as any).status.reason_code,'PRESENTATION_RECEIPT_BINDING_INVALID');
});
test('legacy transport failures become unknown receipts and never proof of a write',()=>{
  const result=presentationResult('presentation_snapshot',args,{isError:true,content:[],structuredContent:{error:{code:'DESKTOP_TIMEOUT'}}});
  assert.equal((result.structuredContent as any).status.state,'unknown');
  assert.equal((result.structuredContent as any).status.reason_code,'DESKTOP_TIMEOUT');
  assert.equal((result.structuredContent as any).next.retry,'after_check');assert.deepEqual((result.structuredContent as any).effects,[]);
});

test('unknown with a saved page still requires a matching native audit; valid partial evidence survives',()=>{
  const edit=demo.plan.edits[0],at=demo.snapshot.captured_at,ref='audit:demo';
  const item={id:edit.work_item_id,label:demo.plan.preview_items[0],state:'succeeded',effect_refs:[ref],slide_id:edit.slide_id,slide_number:edit.slide_number};
  const audit={version:1,operation_id:'op:demo',target:args.target,plan_sha256:demo.plan.plan_sha256,revision:1,items:[item],
    checks:[{work_item_id:item.id,before_text_sha256:edit.before_text_sha256,after_text_sha256:sha256(edit.after_text),saved_at:at,read_back_at:at,evidence_ref:ref}],
    file_sha256:'a'.repeat(64),saved_at:at,review_status:'awaiting_owner'};
  const body={...succeeded({effects:[effect('owner_data',args.target.target_id,'document.text.update','verified',ref,ref)],
    content:[{key:'edit_result',text:JSON.stringify(audit),provenance:'observed'}]}),work_items:[item]};body.status.state='unknown';
  const action='presentation_edit_status',input={target:args.target,operation_id:'op:demo'};
  const wire=()=>to_mcp_result(body as any) as unknown as CallToolResult;
  assert.equal(presentationResult(action,input,wire()).structuredContent.work_items![0]!.state,'succeeded');
  audit.target={...args.target,document_id:'foreign-doc'};body.content[0]!.text=JSON.stringify(audit);
  const denied=presentationResult(action,input,wire()).structuredContent;
  assert.equal(denied.status.reason_code,'PRESENTATION_RECEIPT_BINDING_INVALID');assert.deepEqual(denied.effects,[]);assert.equal(denied.work_items,undefined);
});
