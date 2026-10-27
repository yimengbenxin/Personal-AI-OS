import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {effectConsent} from '../src/effect-consent.ts';
import {ownerActionGrant,type ProcessedEvent} from '../src/contracts.ts';
import {decide} from '../../../../../capability/packages/phone/tests/gateway.stub.ts';
import {decideConsent} from '../src/capability/consent/decision.ts';

const manifest=JSON.parse(readFileSync(new URL('../../../../../capability/packages/phone/plugin.json',import.meta.url),'utf8')).extensions['ai.yimi.capability'];
const oldKinds:Record<string,string>={read:'read',read_app:'read',purchase_errand:'external',ride_request:'external',
  send_message:'send',wechat_message:'send',send_file:'send',login:'login',file_edit:'file_edit',delete:'delete',pay_order:'external'};
const owner={origin:'explicit_user_prompt',media_type:'text',principal_id:'owner',user_identity:'owner',processed_event_id:'d:owner',
  content:{text:'本次请求'},source:{channel:'text'},processing:{path_id:'text'},speakers:[]} as unknown as ProcessedEvent;
const context={run_id:'run',session_id:'session',tool_call_id:'call'};
const cells:{scope:string;tool:string;requested:boolean;p2:string;n13:string}[]=[];

for(const scope of ['owner','guest','care','background','cron','background_unbound','cron_unbound'])test(`phone decisions equal current authorities in ${scope} scope`,async()=>{
  const event=scope==='owner'?owner:{...owner,origin:'device_observation',processed_event_id:'d:followup',media_type:'app_event',user_identity:null,
    content:{app_event:{kind:scope==='care'?'proactive_care':scope==='guest'?'voice_turn':'scheduled_task',speaker:'speaker:guest'}}} as unknown as ProcessedEvent;
  const ports={admission:{find:()=>({d:event,record:{state:'running'}})},
    storage:{read:async()=>{throw Object.assign(new Error('missing'),{code:'ENOENT'});}},
    ownerOrigin:async()=>['background','cron'].includes(scope)?owner:undefined,paymentSource:()=>({ride_allowed:false})} as unknown as Parameters<typeof effectConsent>[0];
  async function outcome(work:Promise<unknown>){try{return await work;}catch(error){return {error:(error as {code:string}).code};}}
  for(const [task_type,kind] of Object.entries(oldKinds))for(const requested of [false,true]){
    const legacy=await outcome(effectConsent(ports,context,{kind,task_type,requested,...(kind==='send'?{recipient:'contact:fixed'}:{})}));
    const packaged=await outcome(decide(ports,context,manifest.tools.phone_task,{task_type,recipient:'contact:fixed',owner_requested:requested}));
    assert.deepEqual(packaged,legacy,`${task_type} requested=${requested}`);
  }
  for(const tool of Object.keys(manifest.tools).filter(tool=>tool!=='phone_task')){
    const current=(await ownerActionGrant(event,ports.ownerOrigin)).length>0;
    const bound=current&&manifest.scopes.includes('owner');
    const effect=manifest.tools[tool].effect as string;
    // P2's cell for this tool and scope: allowed exactly when the run is bound to the owner.
    const p2=current?'allow':'block';
    if(effect==='observe'||effect==='workspace'){for(const requested of [true,false])cells.push({scope,tool,requested,p2,n13:bound?'allow':'block'});continue;}
    // A class that needs consent takes that class's existing gate through the
    // gateway's real decision path (manifest class + scope, then the single consent authority).
    for(const requested of [true,false]){
      const gated=!bound&&!['background_unbound','cron_unbound'].includes(scope)?'block':(await decideConsent({
        effectConsent:(...args)=>effectConsent(ports,...args),spend:async()=>assert.fail('not spend'),selfChange:async()=>assert.fail('not self_change')},
        {context,effect,target:'千问',task_type:manifest.tools[tool].task_type,owner_requested:requested,scope_allowed:true,
          consent_required:true,invocation:scope==='owner'?'interactive':'cron'})).action;
      cells.push({scope,tool,requested,p2,n13:gated});
    }
  }
});

test('phone single-tool cells: only the owner-decision cells differ from P2',()=>{
  // 7 tools x 7 scopes = P2's 49 single-tool cells, each now also split by owner_requested.
  const original=cells.filter(cell=>cell.tool!=='phone_check'),checks=cells.filter(cell=>cell.tool==='phone_check');
  assert.equal(original.length,98);assert.equal(checks.length,14);assert.equal(cells.length,112);
  for(const cell of checks)assert.equal(cell.n13,original.find(row=>row.tool==='phone_status'&&row.scope===cell.scope&&row.requested===cell.requested)!.n13);
  const changed=cells.filter(cell=>cell.n13!==cell.p2).map(cell=>`${cell.tool} ${cell.scope} requested=${cell.requested} -> ${cell.n13}`);
  assert.deepEqual(cells.filter(cell=>cell.requested).filter(cell=>cell.n13!==cell.p2),[]);
  assert.deepEqual(changed.sort(),['owner','background','cron'].flatMap(scope=>['phone_restore_apps','phone_save_apps']
    .map(tool=>`${tool} ${scope} requested=false -> ${scope==='owner'?'approve':'block'}`)).sort());
  console.log(JSON.stringify({p2_cells:203,phone_task_cells_identical:154,single_tool_cells:49,check_cells:14,changed_when_not_requested:changed.sort()}));
});
