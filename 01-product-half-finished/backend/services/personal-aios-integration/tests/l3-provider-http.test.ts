import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, readFile, writeFile, access, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {createRequire} from 'node:module';
import {spawn} from 'node:child_process';
import {L3Service} from '../src/memory/l3.ts';
import {prepareMemoryCommand, type MemoryCommandInput} from '../src/memory/tools.ts';
import {validateCommand} from '../src/memory/contracts.ts';
import {ContractError, sha256} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {RawArchive} from '../src/archive.ts';
import {RunAdmission} from './native-source-fixture.ts';
import {OutputAuthority} from '../src/output.ts';
import {PersonalAIOSRuntime} from './native-source-fixture.ts';
import {createPersonalAIOSServer} from '../src/server.ts';
import {fileURLToPath} from 'node:url';

const require=createRequire(new URL('../../platform-data/package.json',import.meta.url));
const {Pool}=require('pg') as {Pool:new(config:Record<string,unknown>)=>ConstructorParameters<typeof L3Service>[0]};
const database=process.env.PAIOS_L3_TEST_DATABASE_URL;

test('real MEM/PG authority errors survive authenticated HTTP and existing Python provider without guessed codes', {skip:!database}, async t=>{
  const sourceRoot=process.env.PAIOS_NATIVE_SOURCE_TEST_ROOT;
  const python=process.env.PAIOS_NATIVE_TEST_PYTHON ?? (sourceRoot && join(sourceRoot,'.venv','bin','python'));
  if(!sourceRoot||!python){t.skip('isolated native Python unavailable'); return;}
  try {await access(python);} catch {t.skip('isolated native Python unavailable'); return;}
  // provider() below is a hoisted declaration, so it sees these bindings' declared types, not the narrowing above.
  const nativeRoot:string=sourceRoot,nativePython:string=python;
  const schema='paios_fixture_errors_'+randomUUID().replaceAll('-','').slice(0,16);
  const admin=new Pool({connectionString:database}); await admin.query('CREATE SCHEMA '+schema); console.info('isolated_schema_created',schema);
  const pool=new Pool({connectionString:database,options:'-c search_path='+schema}); let ended=false;
  const folder=await mkdtemp(join(tmpdir(),'paios-l3-http-')); const keyPath=join(folder,'internal.key');
  const internal='synthetic-internal-contract-key'; await writeFile(keyPath,internal,{mode:0o600});
  const storage=new PosixStorage(join(folder,'data')); const archive=new RawArchive(storage,8192);
  const native={create:async()=>({run_id:'fixture-run',session_id:'fixture-session',conversation_session_id:'fixture-session',status:'running'}),
    status:async()=>({run_id:'fixture-run',session_id:'fixture-session',conversation_session_id:'fixture-session',status:'running'}),cancel:async()=>({run_id:'fixture-run',status:'cancelled'})};
  const admission=new RunAdmission(storage,native,{max_pending_events:8,max_pending_bytes:65536,max_event_age_ms:10000,
    poll_interval_ms:10,native_idempotency_retention_ms:86400000,policy_version:'fixture'});
  const device={principal_id:'owner',device_id:'mac',device_type:'mac' as const,channel:'http',consent_ref:'fixture',
    token_sha256:sha256('synthetic-device-key'),route_version:'fixture-route',output_modes:['text']};
  const runtime=new PersonalAIOSRuntime({storage,archive,admission,native,output:new OutputAuthority(storage),
    devices:[device],skill:'fixture',max_read_bytes:8192,l3:new L3Service(pool)});
  const server=createPersonalAIOSServer(runtime,{internal_token:internal,max_request_bytes:32768,request_timeout_ms:5000});
  try {
    await pool.query(await readFile(new URL('../../../migrations/0009_hermes_l3.up.sql',import.meta.url),'utf8'));
    await pool.query(await readFile(new URL('../../../migrations/0012_l3_payload_audit_split.up.sql',import.meta.url),'utf8'));
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const address=server.address(); assert.ok(address && typeof address!=='string'); const url='http://127.0.0.1:'+address.port;
    const submitted=await runtime.submit({schema_version:'paios.event.v1',event_id:'fixture-event',device_id:'mac',device_type:'mac',
      captured_at:'2026-10-01T00:00:00.000Z',source:{channel:'http'},media_type:'text',mime:'text/plain;charset=utf-8',
      representation:'uploaded_original',payload:Buffer.from('synthetic score source contract')},await runtime.authenticate('synthetic-device-key'),'fixture-session',true);
    for(let attempt=0;!admission.find('fixture-run','fixture-session');attempt++) {
      assert.ok(attempt<100,'fixture run binding timeout'); await new Promise(resolve=>setTimeout(resolve,5));
    }
    const d=submitted.processed_event; const evidence={event_id:d.event_id,processed_event_id:d.processed_event_id,raw_ref:d.raw_ref,
      archive_revision:d.archive_revision,time_range:d.time_range};
    function command(command_id:string):MemoryCommandInput {
      return {command_id,operation:'create',expected_version:0,evidence_refs:[evidence],assertion:{assertion_id:'fixture-assertion',
        kind:'inference',subject_ref:{type:'unknown_subject',id:'synthetic-record'},predicate:'synthetic-role',value:'test',
        scope:{principal_id:'owner',purpose:'test',situation:'test',role:'test',evaluation_frame:'test'},evidence_refs:[evidence],
        evidence_status:'available',unknown_conditions:[],conflicts:[],status:'candidate',applicability_status:'applicable',relation_to_peers:'independent',
        typed_scores:{interpretation_support:{value_or_interval:.65,scale:[0,1],basis_refs:[d.raw_ref]},
          criterion_priority:{value_or_interval:8,scale:[0,10],scope_ref:'test',basis_refs:[d.raw_ref]}},depends_on:[]}};
    }
    async function provider(args:unknown, call:string, tool='paios_l3_commit') {
      const script=`import importlib.util,json,sys\np=sys.argv[1];spec=importlib.util.spec_from_file_location('isolated_contract_provider',p);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)\na=m.PersonalAIOSProvider();a.base_url=sys.argv[2];a.key_file=sys.argv[3];a.initialize('fixture-session',agent_context='primary')\nprint(a.handle_tool_call(sys.argv[5],json.loads(sys.stdin.read()),session_id='fixture-session',run_id='fixture-run',tool_call_id=sys.argv[4]))`;
      const providerPath=process.env.PAIOS_PROVIDER_TEST_SOURCE ?? fileURLToPath(new URL('../../../../../integrations/hermes/personal_aios/__init__.py',import.meta.url));
      return new Promise<Record<string,any>>((resolve,reject)=>{
        const child=spawn(nativePython,['-c',script,providerPath,url,keyPath,call,tool],{cwd:nativeRoot,
          env:{...process.env,HERMES_HOME:join(folder,'native-home'),PYTHONPATH:nativeRoot}});
        let stdout='';let stderr='';child.stdout.on('data',bytes=>{stdout+=bytes;});child.stderr.on('data',bytes=>{stderr+=bytes;});
        child.on('error',reject);child.on('close',code=>code===0?resolve(JSON.parse(stdout)):reject(new Error(stderr.slice(0,4096))));
        child.stdin.end(JSON.stringify(args));
      });
    }
    const unauthorized=await fetch(url+'/internal/hermes/tool-contracts',{headers:{Authorization:'Bearer incorrect'}});
    assert.equal(unauthorized.status,401);
    const declarations=await fetch(url+'/internal/hermes/tool-contracts',{headers:{Authorization:'Bearer '+internal}});
    assert.equal(declarations.status,200);
    const published=await declarations.json() as {name:string;parameters:any}[];
    const scores=published.find(tool=>tool.name==='paios_l3_commit')!.parameters.properties.assertion.properties.typed_scores;
    assert.deepEqual(Object.keys(scores.properties),['interpretation_support','criterion_priority']);
    const basis=scores.properties.interpretation_support.properties.basis_refs;
    assert.equal(new RegExp(basis.items.pattern).test(d.raw_ref),true);
    assert.equal(new RegExp(basis.items.pattern).test(d.raw_ref+'@'+d.archive_revision),false);
    assert.match(basis.description,/Exact raw_ref/);
    const normal=await provider(command('normal'),'normal');
    assert.equal(normal.status,'committed'); assert.equal(normal.assertion_id,'fixture-assertion');
    const inspectionSchema=published.find(tool=>tool.name==='paios_l3_inspect')!;
    assert.deepEqual(Object.keys(inspectionSchema.parameters.properties),['assertion_id']);
    assert.deepEqual(inspectionSchema.parameters.required,['assertion_id']);
    const inspected=await provider({assertion_id:'fixture-assertion'},'inspect-candidate','paios_l3_inspect');
    assert.equal(inspected.status,'found');assert.deepEqual(inspected.current_version.receipt,normal);
    assert.equal(inspected.assertion.status,'candidate');assert.equal(inspected.provenance_status,'complete');
    assert.deepEqual(await provider({assertion_id:'absent'},'inspect-missing','paios_l3_inspect'),
      {status:'not_found',assertion_id:'absent'});
    assert.deepEqual(await provider({assertion_id:'fixture-assertion',principal_id:'foreign'},'inspect-scope','paios_l3_inspect'),
      {status:'rejected',error_code:'UNKNOWN_TOOL_ARGUMENT',http_status:400,success:false,error:'UNKNOWN_TOOL_ARGUMENT'});
    assert.deepEqual(await provider({},'inspect-invalid','paios_l3_inspect'),
      {status:'rejected',error_code:'INVALID_ID',http_status:400,success:false,error:'INVALID_ID'});
    const unknownTool=await provider({},'unknown-tool','paios_unimplemented');
    assert.deepEqual(unknownTool,{status:'rejected',error_code:'TOOL_NOT_ENABLED',http_status:404,success:false,error:'TOOL_NOT_ENABLED'});
    const unknownArgument=await provider({reply_mode:'text',principal_id:'foreign'},'unknown-argument','paios_open_reply');
    assert.deepEqual(unknownArgument,{status:'rejected',error_code:'UNKNOWN_TOOL_ARGUMENT',http_status:400,success:false,error:'UNKNOWN_TOOL_ARGUMENT'});
    const wrong=command('wrong-basis');wrong.assertion.typed_scores.interpretation_support!.basis_refs=[d.raw_ref+'@'+d.archive_revision];
    assert.throws(()=>validateCommand(prepareMemoryCommand(wrong),'owner'),error=>error instanceof ContractError &&
      error.code==='L3_SCORE_WITHOUT_EVIDENCE' && error.status===422);
    const malformed=command('malformed');malformed.assertion.typed_scores.interpretation_support!.scale=[] as unknown as [number,number];
    assert.throws(()=>validateCommand(prepareMemoryCommand(malformed),'owner'),error=>error instanceof ContractError && error.status===422);
    for(const [args,code,status] of [
      [wrong,'L3_SCORE_WITHOUT_EVIDENCE',422],
      [{...command('wrong-scope'),assertion:{...command('wrong-scope').assertion,scope:{...command('wrong-scope').assertion.scope,principal_id:'foreign'}}},'L3_SCOPE_DENIED',403],
      [{...command('wrong-version'),expected_version:99},'L3_VERSION_CONFLICT',409],
      [malformed,'L3_INVALID_SCORE',422],
    ] as const) {
      const actual=await provider(args,code);
      assert.deepEqual(actual,{status:'rejected',error_code:code,http_status:status,success:false,error:code});
    }
    const committed=await pool.query(`SELECT r.receipt,p.command_payload FROM paios_l3_receipts r JOIN paios_l3_payloads p ON r.principal_id=p.principal_id AND r.command_id=p.command_payload->>'command_id'`);
    assert.equal(committed.rows.length,1);assert.deepEqual(committed.rows[0].receipt,normal);
    assert.deepEqual(committed.rows[0].command_payload.assertion.typed_scores.interpretation_support.basis_refs,[d.raw_ref]);
    const owner={authenticated:true,principal_id:'owner',run_id:'fixture-run',context_ref:'fixture-ui',
      authorize:async()=>true,evidenceAvailable:async()=>true};
    const l3=new L3Service(pool);
    const role=command('http-role-create');role.assertion.assertion_id='http-role';
    role.assertion.subject_ref={type:'known_person',id:'owner'};
    await l3.commit(prepareMemoryCommand(role),owner);
    const active={...role,command_id:'http-role-review',operation:'review' as const,expected_version:1,
      assertion:{...role.assertion,status:'active' as const}};
    const activeReceipt=await l3.commit(prepareMemoryCommand(active),owner);
    const dependent=command('http-dependent-create');dependent.assertion.assertion_id='http-dependent';
    dependent.assertion.depends_on=[{assertion_id:'http-role',version:2,dependency_kind:'use'}];
    await l3.commit(prepareMemoryCommand(dependent),owner);
    const activeRead=await provider({assertion_id:'http-role'},'inspect-active','paios_l3_inspect');
    assert.equal(activeRead.assertion.status,'active');assert.deepEqual(activeRead.current_version.receipt,activeReceipt);
    const denial={...active,command_id:'http-role-deny',operation:'deny' as const,expected_version:2};
    const denyReceipt=await l3.commit(prepareMemoryCommand(denial),owner);
    const denied=await provider({assertion_id:'http-role'},'inspect-denied','paios_l3_inspect');
    // memory-v4: inspecting a stopped or invalidated assertion explains why, without returning its fact payload.
    assert.equal(denied.status,'retracted');assert.equal(denied.applicability_status,'stopped');assert.equal(denied.assertion,undefined);
    assert.equal(denied.current_version.operation,'deny');
    assert.deepEqual(denied.current_version.receipt,denyReceipt);
    const dependentRead=await provider({assertion_id:'http-dependent'},'inspect-dependent','paios_l3_inspect');
    assert.equal(dependentRead.status,'invalidated');assert.equal(dependentRead.applicability_status,'needs_reevaluation');assert.equal(dependentRead.assertion,undefined);
    assert.deepEqual(dependentRead.invalidation_causes[0].receipt,denyReceipt);
    assert.equal(dependentRead.invalidation_causes[0].changed_version,3);
    const independentRead=await provider({assertion_id:'fixture-assertion'},'inspect-independent','paios_l3_inspect');
    assert.deepEqual(independentRead.assertion,inspected.assertion);
    const deletion=command('fixture-delete');deletion.operation='delete';deletion.expected_version=1;
    const deletedReceipt=await new L3Service(pool).commit(prepareMemoryCommand(deletion),owner);
    const stopped=await provider({assertion_id:'fixture-assertion'},'inspect-deleted','paios_l3_inspect');
    assert.equal(stopped.status,'deleted');assert.equal(stopped.applicability_status,'stopped');assert.equal(stopped.assertion,undefined);
    assert.equal(stopped.current_version.operation,'delete');assert.deepEqual(stopped.current_version.receipt,deletedReceipt);
    assert.deepEqual(await provider({assertion_id:'fixture-assertion'},'query-deleted','paios_l3_query'),{assertions:[],truncated:false,next_cursor:null});
    const beforeReads=(await pool.query('SELECT count(*)::int AS n FROM paios_l3_receipts')).rows[0].n;
    await provider({assertion_id:'fixture-assertion'},'inspect-repeat','paios_l3_inspect');
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM paios_l3_receipts')).rows[0].n,beforeReads);
    await pool.end();ended=true;
    assert.deepEqual(await provider({assertion_id:'fixture-assertion'},'inspect-unavailable','paios_l3_inspect'),
      {status:'rejected',error_code:'INTERNAL_ERROR',http_status:500,success:false,error:'INTERNAL_ERROR'});
    const unavailable=await provider(command('closed-database'),'database-unavailable');
    assert.deepEqual(unavailable,{status:'rejected',error_code:'INTERNAL_ERROR',http_status:500,success:false,error:'INTERNAL_ERROR'});
    assert.equal('receipt_ref' in unavailable,false);
  } finally {
    await Promise.all([server.closeAndDrain(),runtime.close()]);
    if(!ended)await pool.end();await admin.query('DROP SCHEMA '+schema+' CASCADE'); console.info('isolated_schema_dropped',schema);await admin.end();await rm(folder,{recursive:true,force:true});
  }
});
