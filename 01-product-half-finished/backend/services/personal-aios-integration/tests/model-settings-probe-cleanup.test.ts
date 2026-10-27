import test from 'node:test';
import assert from 'node:assert/strict';
import {probeModelConnection} from '../src/model-settings-probe.ts';

const input={provider:{id:'fixture',display_name:'Fixture',wire_protocol:'chat_completions' as const,
  base_url:'https://127.0.0.1/v1',credential_ref:'fixture-key'},model_id:'fixture-model',parameters:{},
  key:'fake-key-no-network',allow_private_hosts:['127.0.0.1'],trace_id:'fixture-probe'};

for(const ending of ['finite','unterminated','cancel-rejects','cancel-pending'] as const){
  test(`probe cancels and unlocks an oversized ${ending} response before aborting its request`,{timeout:1000},async t=>{
    const events:string[]=[];let calls=0,requestSignal:AbortSignal|undefined;
    const body=new ReadableStream<Uint8Array>({
      start(controller){
        controller.enqueue(new Uint8Array(262145));
        if(ending==='finite'){
          // The finite response still has unread bytes when the first chunk exceeds the limit.
          controller.enqueue(new TextEncoder().encode('unread tail'));
          controller.close();
        }
      },
      cancel(){
        events.push('cancel');
        if(ending==='cancel-rejects')return Promise.reject(new Error('fixture cancellation rejected'));
        if(ending==='cancel-pending')return new Promise<void>(()=>{});
      }
    });
    t.mock.method(globalThis,'fetch',async(_url:unknown,options?:RequestInit)=>{
      calls++;assert.equal(String(_url),'https://127.0.0.1/v1/chat/completions');
      assert.ok(options?.signal);requestSignal=options.signal;
      requestSignal.addEventListener('abort',()=>events.push(body.locked?'abort-locked':'abort'),{once:true});
      return new Response(body,{status:200});
    });
    const result=await probeModelConnection(input);
    assert.equal(calls,1);assert.equal(result.status,'failed');assert.equal(result.http_status,200);
    assert.equal(result.safe_error,'MODEL_SETTINGS_PROBE_FAILED','cleanup must not reclassify the size limit as a timeout');
    assert.equal(result.usage,null);assert.equal(result.fallback_activated,false);
    assert.deepEqual(events,['cancel','abort'],'cancel the unread response and release its reader before aborting');
    assert.equal(body.locked,false);assert.equal(requestSignal?.aborted,true);
  });
}

for(const status of [200,401]){
  test(`probe releases a fully consumed ${status} response without aborting or losing its result`,async t=>{
    let cancelled=0,requestSignal:AbortSignal|undefined;
    const payload=status===200?{model:'fixture-model',usage:{prompt_tokens:12,completion_tokens:3,
      prompt_tokens_details:{cached_tokens:4}}}:{error:{code:'authentication_error'}};
    const body=new ReadableStream<Uint8Array>({
      start(controller){controller.enqueue(new TextEncoder().encode(JSON.stringify(payload)));controller.close();},
      cancel(){cancelled++;}
    });
    t.mock.method(globalThis,'fetch',async(_url:unknown,options?:RequestInit)=>{
      assert.ok(options?.signal);requestSignal=options.signal;return new Response(body,{status});
    });
    const result=await probeModelConnection(input);
    assert.equal(result.status,status===200?'passed':'failed');assert.equal(result.http_status,status);
    assert.equal(result.safe_error,status===200?null:'authentication_error');
    assert.equal(result.actual_model,status===200?'fixture-model':null);
    assert.deepEqual(result.usage,status===200?{prompt_tokens:12,completion_tokens:3,cached_tokens:4}:null);
    assert.equal(result.fallback_activated,false);assert.equal(cancelled,0);
    assert.equal(body.locked,false,'the completed reader must release its lock');
    assert.equal(requestSignal?.aborted,false,'a complete response needs no remaining-request abort');
  });
}
