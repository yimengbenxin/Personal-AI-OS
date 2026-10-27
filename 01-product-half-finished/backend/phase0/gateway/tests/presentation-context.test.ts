import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {watchPresentationContext} from '../src/presentation-context.ts';
const target=JSON.parse(readFileSync(new URL('../../../../../capability/packages/meeting-assistant/tests/demo.json',import.meta.url),'utf8')).snapshot.target;

test('target context uses existing MCP metadata and changed notifications, without altering the tool list',async()=>{
  let handler:()=>Promise<void>,value:any={target,shared_window_id:42,origin_processed_event_id:'d:owner',session_id:'conversation',attachment_grant_id:'grant:demo'};
  const contexts:any[]=[],errors:any[]=[],client={setNotificationHandler:(_schema:any,fn:any)=>{handler=fn;},listTools:async()=>({tools:[],_meta:{'ai.yimi.presentation':value}})};
  const stop=watchPresentationContext({client:client as any,initial:{tools:[],_meta:{'ai.yimi.presentation':value}},current:()=>true,authorize:async()=>{},context:async context=>{contexts.push(context);},error:error=>{errors.push(error);}});
  await new Promise<void>(resolve=>setImmediate(resolve));assert.equal(contexts.length,1);
  value=null;await handler!();assert.equal(contexts.at(-1),null);
  value={...contexts[0],target:{...target,file_url:'https://online/doc'}};await handler!();assert.equal(errors.length,1);assert.equal(contexts.length,2);
  stop();
});
