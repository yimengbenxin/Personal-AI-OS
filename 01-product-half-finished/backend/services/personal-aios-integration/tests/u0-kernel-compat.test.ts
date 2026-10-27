import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {spawn} from 'node:child_process';
import {PersonalAIOSRuntime,RunAdmission,nativeSubmission,type NativeClient,type NativeRun} from './native-source-fixture.ts';
import {PosixStorage} from '../src/storage.ts';
import {OutputAuthority} from '../src/output.ts';
import {RawArchive} from '../src/archive.ts';
import {createPersonalAIOSServer} from '../src/server.ts';
import {sha256} from '../src/contracts.ts';

const root=new URL('../../../../../',import.meta.url).pathname.replace(/\/$/u,''),token='synthetic-u0-internal-token-abcdefgh';
const enabled=process.env.PAIOS_U0_KERNEL_PROOF==='1';
const proof:unknown[]=[];
for(const [label,nativeSource] of [['stock',process.env.PAIOS_U0_STOCK_SOURCE],['composition',process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT]] as const)
test(`U0 documented hooks on real ${label} agents`,{skip:!enabled,timeout:600000},async t=>{
  assert.ok(nativeSource&&existsSync(nativeSource),'Set both fixed native source paths');
  const modes=(process.env.PAIOS_U0_CASES??'depth1,depth2,concurrent,loss,loss-start,loss-turn,disconnect,media,compression,recovery').split(',');
  for(const mode of modes){
    const folder=await mkdtemp(join(tmpdir(),`u0-${label}-${mode}-`)),storage=new PosixStorage(join(folder,'storage'));
    const progress=join(folder,'progress.jsonl'),runs=new Map<string,NativeRun>();
    const status=(id:string):NativeRun=>{
      const events=existsSync(progress)?readFileSync(progress,'utf8').split('\n').slice(0,-1).filter(Boolean).map(line=>JSON.parse(line))
        .filter(event=>event.run_id===id&&['subagent.start','subagent.complete'].includes(event.event)).map(event=>({
          ...event,goal:event.goal??event.preview??'',subagent_id:event.subagent_id??event.child_subagent_id})):[];
      return {...runs.get(id)!,activity_events:events};
    };
    const native:NativeClient={create:async body=>{
      const row:NativeRun={run_id:`run-${runs.size}`,session_id:body.session_id,conversation_session_id:body.session_id,status:'running'};
      runs.set(row.run_id,row);return row;
    },status:async id=>status(id),cancel:async id=>({...status(id),status:'cancelled'})};
    const platform=()=>{
      const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:1048576,max_event_age_ms:600000,
        poll_interval_ms:20,native_idempotency_retention_ms:86400000,policy_version:'u0-native-fixture'});
      const runtime=new PersonalAIOSRuntime({storage,native,admission,output:new OutputAuthority(storage),archive:new RawArchive(storage,1048576),
        skill:'fixture',max_read_bytes:1048576,devices:[{principal_id:'owner',device_id:'mac',device_type:'mac',channel:'http',
          consent_ref:'fixture',token_sha256:sha256('device'),route_version:'fixture',output_modes:['text']}]});
      runtime.capabilityGateway.tools.clear();runtime.capabilityGateway.tools.set('mcp__u0_fixture__effect',{
        package:'u0-fixture',server:'u0_fixture',name:'effect',scopes:['owner'],effect:'workspace',retry:'forbidden'});
      const server=createPersonalAIOSServer(runtime,{internal_token:token,max_request_bytes:4<<20,request_timeout_ms:10000});
      return {admission,runtime,server};
    };
    let {admission,runtime,server}=platform();
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address();assert.ok(address&&typeof address!=='string');
    try{
      const source=await runtime.authenticate('device'),roots=[];
      for(let i=0;i<(mode==='concurrent'?2:1);i++){
        const session=`${label}-${mode}-${i}`;
        const submitted=await runtime.submit({schema_version:'paios.event.v1',event_id:session,device_id:'mac',device_type:'mac',captured_at:new Date().toISOString(),
          source:{channel:'http'},media_type:'text',mime:'text/plain;charset=utf-8',representation:'uploaded_original',
          payload:Buffer.from('U0_ROOT_'+session)},source,session,true);
        let run:string|undefined;
        for(let n=0;n<400;n++){run=(await admission.getAsync('owner',session,submitted.processed_event.processed_event_id))?.run_id;
          if(run)break;await new Promise(resolve=>setTimeout(resolve,5));}
        assert.ok(run);roots.push({session,run,input:nativeSubmission(native,run).input});
      }
      const request=join(folder,'request.json');
      const gate=join(folder,'gate.json'),ready=join(folder,'ready'),release=join(folder,'release');
      await writeFile(request,JSON.stringify({root,home:join(folder,'native'),base:`http://127.0.0.1:${address.port}`,token,progress,mode,
        roots,gate,ready,release,depth:mode==='depth1'?1:2}));
      const child=spawn(process.env.PAIOS_HERMES_PYTHON!,[join(root,'tests/hermes/fixtures/u0-native.py'),request],{
        env:{...process.env,PYTHONPATH:nativeSource},stdio:['ignore','pipe','pipe']});
      const completion=new Promise<any>((resolve,reject)=>{
        let output='',errors='';child.stdout.on('data',data=>output+=data);child.stderr.on('data',data=>errors+=data);
        const timeout=setTimeout(()=>child.kill('SIGTERM'),180000);
        child.on('error',reject);child.on('exit',code=>{
          clearTimeout(timeout);
          if(code!==0)return reject(new Error(`${label}/${mode}: ${errors}\n${output}`));
          const rows=output.split('\n').flatMap(line=>{try{return [JSON.parse(line)];}catch{return [];}});
          resolve(rows.find(row=>row.fixture==='u0-native'));
        });
      });
      const recovery=(async()=>{
        if(mode!=='recovery')return;
        const deadline=Date.now()+80000;
        while(!existsSync(ready)&&child.exitCode===null&&Date.now()<deadline)await new Promise(resolve=>setTimeout(resolve,10));
        assert.ok(existsSync(ready),'native MCP must pause after its real admission');
        const call=JSON.parse(await readFile(gate,'utf8'));
        await server.closeAndDrain();await runtime.close();
        ({admission,runtime,server}=platform());
        await new Promise<void>(resolve=>server.listen(address.port,'127.0.0.1',resolve));
        const entry=await admission.hookBinding(call,true);
        assert.equal(entry.record.run_id,roots[0]!.run);await writeFile(release,'verified');
      })();
      const [result]=await Promise.all([completion,recovery]).finally(()=>{if(child.exitCode===null)child.kill('SIGTERM');});
      assert.ok(result,`${label}/${mode}: missing native result`);
      const blocked=['loss','loss-start','disconnect'].includes(mode);
      assert.equal(result.effects.length,blocked?0:roots.length,`${label}/${mode}: ${JSON.stringify(result)}`);
      if(!blocked)for(const item of roots){
        assert.equal(result.effects.filter((effect:{label:string})=>effect.label===item.session).length,1);
        const ledger=await runtime.capabilityGateway.ledger.records({principal_id:'owner',run_id:item.run});
        assert.equal(ledger.filter(row=>row.receipt.effects.some(effect=>effect.target===item.session)).length,1);
        assert.ok(ledger.every(row=>row.receipt.effects.every(effect=>effect.target===item.session)));
      }
      assert.ok(result.tool_ids.every((ids:{api_request_id:string})=>!roots.some(row=>row.run===ids.api_request_id)));
      for(const ids of result.tool_ids)assert.ok(result.hooks.some((row:any)=>row.hook==='pre_api_request'&&
        row.payload.task_id===ids.task_id&&row.payload.turn_id===ids.turn_id&&row.payload.api_request_id===ids.api_request_id));
      const starts=result.hooks.filter((row:any)=>row.hook==='subagent_start'&&row.status===200).length;
      const stops=result.hooks.filter((row:any)=>row.hook==='subagent_stop'&&row.status===200).length;
      if(!blocked)assert.equal(stops,starts,`${label}/${mode}: public stop bridge must settle every child`);
      if(mode==='media'){
        assert.ok(result.media_in_model,'MCP attachments must remain visible to the model');
        assert.ok(result.image_in_model,'MCP pixels must remain visible on the native image route');
        assert.ok(result.resource_bytes_preserved,'MCP resource bytes must survive native caching');
      }
      if(mode==='compression')assert.ok(result.compressed);
      proof.push({kernel:label,mode,effects:result.effects.length,expected:blocked?0:roots.length,
        public_starts:starts,public_stops:stops,
        media_in_model:result.media_in_model,image_in_model:result.image_in_model,
        resource_bytes_preserved:result.resource_bytes_preserved,passed:true});
      if(process.env.PAIOS_U0_PROOF_FILE)await writeFile(process.env.PAIOS_U0_PROOF_FILE,JSON.stringify(proof,null,2)+'\n');
    }finally{
      await server.closeAndDrain();await runtime.close();await rm(folder,{recursive:true,force:true});
    }
  }
});
