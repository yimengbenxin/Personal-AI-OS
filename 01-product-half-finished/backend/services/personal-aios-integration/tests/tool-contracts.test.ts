import { Ajv } from 'ajv';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { mkdtemp,rm,writeFile,mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { enabledToolSchemas } from '../src/tool-contracts.ts';
import { prepareMemoryCommand, type MemoryCommandInput } from '../src/memory/tools.ts';
import { commandDigest } from '../src/memory/contracts.ts';

test('actual Hermes run-scope policy withholds owner data schemas and blocks forged dispatch', async t => {
  const patch = readFileSync(new URL('../../../../../integrations/hermes/personal_aios/native-context.patch', import.meta.url), 'utf8');
  const start = patch.indexOf('diff --git a/gateway/run_scope.py '), end = patch.indexOf('\ndiff --git ', start + 1);
  assert.ok(start >= 0 && end > start);
  const source = patch.slice(start, end).split('\n').filter(line => line.startsWith('+') && !line.startsWith('+++')).map(line => line.slice(1)).join('\n');
  const root=await mkdtemp(join(tmpdir(),'paios-scope-contract-'));t.after(()=>rm(root,{recursive:true,force:true}));
  await mkdir(join(root,'platforms'));
  await writeFile(join(root,'platforms/native-run.shape.schema.json'),readFileSync(new URL('../src/native-run.shape.schema.json',import.meta.url)));
  await writeFile(join(root,'run_scope.py'),source);
  const names = enabledToolSchemas({memory: true, health: true, contacts: true, visual:true,voiceprint:true}).map(schema => schema.name);
  const code = `import json,sys,runpy\nfrom types import SimpleNamespace\nglobals().update(runpy.run_path(sys.argv[2]))\nnames=json.loads(sys.argv[1])\n` +
    `for scope in (*RUN_SCOPES,'care'):\n agent=SimpleNamespace(tools=[{'function':{'name':n}} for n in names])\n restrict_agent(agent,scope)\n` +
    ` for name in ['paios_health_query','paios_contacts_search','paios_visual_recall','paios_visual_delete','paios_people','paios_speaker_name','paios_personality_zone']:\n` +
    `  allowed=scope=='owner' or scope=='care' and name=='paios_health_query'\n` +
    `  assert (name in [_tool_name(t) for t in agent.tools]) == allowed\n` +
    `  assert (tool_block(agent,name) is None) == allowed\n` +
    ` for name in ['paios_terminal_question','paios_call_offer']:\n  assert (tool_block(agent,name) is None) == (scope in ('owner','care'))\n` +
    ` assert tool_block(agent,'paios_open_reply') is None\n`;
  const result = spawnSync('python3', ['-c', code, JSON.stringify(names),join(root,'run_scope.py')], {encoding: 'utf8', timeout: 10000});
  assert.equal(result.status, 0, result.stderr || String(result.error));
});

function input(): MemoryCommandInput {
  const evidence = {event_id: 'event', processed_event_id: 'processed', raw_ref: `l5:${'1'.repeat(64)}`,
    archive_revision: '2'.repeat(64), time_range: {kind: 'instant' as const, timebase_id: 'clock', at_ms: 0}};
  return {command_id: 'command', operation: 'create', expected_version: 0, evidence_refs: [evidence],
    assertion: {assertion_id: 'assertion', kind: 'inference', subject_ref: {type: 'unknown_subject', id: 'unknown'},
      predicate: 'role', value: 'coordinator', scope: {principal_id: 'owner', purpose: 'advice', situation: 'work',
        role: 'unknown', evaluation_frame: 'business'}, evidence_refs: [evidence], evidence_status: 'available',
      unknown_conditions: ['identity unknown'], conflicts: [], status: 'candidate', applicability_status: 'applicable',
      relation_to_peers: 'unknown', typed_scores: {}, depends_on: []}};
}
test('enabled central schema registers only implemented tools and leaves confirmation out of model tools', () => {
  assert.deepEqual(enabledToolSchemas({memory: false}).map(s => s.name), ['paios_l5_read', 'paios_l5_locate', 'paios_open_reply','paios_personality_zone','paios_task_amend','paios_terminal_question','paios_call_offer','paios_glasses_pay','paios_visual_delete','paios_payment','paios_avatar','paios_senses']);
  assert.deepEqual(enabledToolSchemas({memory: true}).map(s => s.name),
    ['paios_l5_read', 'paios_l5_locate', 'paios_open_reply','paios_personality_zone','paios_task_amend', 'paios_l3_query', 'paios_l3_inspect', 'paios_l3_commit', 'paios_l3_forget','paios_terminal_question','paios_call_offer','paios_glasses_pay','paios_visual_delete','paios_payment','paios_avatar','paios_senses']);
  assert.equal(enabledToolSchemas({memory: true, actions: true}).some(s => s.name === 'paios_action_request'), true);
  // Owner-only ambient tools appear only with the journal / voiceprint registry they serve.
  assert.deepEqual(enabledToolSchemas({memory: false, ambient: true, voiceprint: true}).map(s => s.name).slice(5),
    ['paios_terminal_question','paios_call_offer','paios_glasses_pay','paios_visual_delete','paios_payment','paios_avatar','paios_senses','paios_ambient_journal_search', 'paios_speaker_name','paios_people']);
  assert.equal(enabledToolSchemas({memory: false, ambient: true}).some(s => s.name === 'paios_speaker_name'), false);
  assert.deepEqual(enabledToolSchemas({memory: false, voiceprint: true}).find(s => s.name === 'paios_speaker_name')!.parameters.required, ['speaker']);
  for (const schema of enabledToolSchemas({memory: true})) {
    assert.equal(schema.parameters.type, 'object'); assert.equal(schema.parameters.additionalProperties, false);
    assert.equal(schema.name.includes('action'), false); assert.equal(schema.name.includes('confirm'), false);
    for (const field of ['principal_id', 'run_id', 'session_id', 'authenticated', 'authorize', 'consent_ref']) {
      assert.equal(field in schema.parameters.properties, schema.name==='paios_task_amend'&&field==='run_id');
    }
  }
  const commit = enabledToolSchemas({memory: true}).find(s => s.name === 'paios_l3_commit')!;
  const read = enabledToolSchemas({memory: false}).find(s => s.name === 'paios_l5_read')!;
  const pay=new Ajv().compile(enabledToolSchemas({memory:false}).find(s=>s.name==='paios_glasses_pay')!.parameters);
  assert.ok(pay({}));assert.equal(pay({amount:10}),false);
  assert.deepEqual(read.parameters.required, []);
  assert.ok(read.parameters.properties.source_range);
  assert.equal((read.parameters.properties.track_ids as any).uniqueItems, true);
  assert.equal(commit.parameters.required.includes('payload_sha256'), false);
  assert.equal('payload_sha256' in commit.parameters.properties, false);
  assert.deepEqual(commit.parameters.required, []);
  assert.equal(commit.parameters.oneOf!.length, 2);
  const action = enabledToolSchemas({memory: true, actions: true}).find(s => s.name === 'paios_action_request')!;
  for (const field of ['action_id', 'payload_sha256', 'consent_ref', 'run_id']) {
    assert.equal(field in action.parameters.properties, false);
  }
});
test('contract consumers cannot mutate future schema responses', () => {
  const first = enabledToolSchemas({memory: true}); first[0]!.parameters.required.push('principal_id');
  first[0]!.parameters.properties.principal_id = {type: 'string'};
  assert.equal(enabledToolSchemas({memory: true})[0]!.parameters.required.includes('principal_id'), false);
  assert.equal('principal_id' in enabledToolSchemas({memory: true})[0]!.parameters.properties, false);
});
test('MEM derives identical stable digest for omitted or correct supplied digest without changing arguments', () => {
  const args = input(); const before = structuredClone(args);
  const prepared = prepareMemoryCommand(args);
  assert.equal(prepared.payload_sha256, commandDigest(args as Omit<typeof prepared, 'payload_sha256'>));
  assert.deepEqual(args, before);
  assert.deepEqual(prepareMemoryCommand(prepared), prepared);
  assert.equal(prepareMemoryCommand({...args, expected_version: 1}).payload_sha256 === prepared.payload_sha256, false);
});
test('forged supplied digest and top-level caller/run/authorization fields reject at MEM boundary', () => {
  assert.throws(() => prepareMemoryCommand({...input(), payload_sha256: '0'.repeat(64)}), /DIGEST_MISMATCH/);
  for (const key of ['principal_id', 'run_id', 'session_id', 'authenticated', 'authorization', 'authorize', 'consent_ref', 'unknown']) {
    assert.throws(() => prepareMemoryCommand({...input(), [key]: 'model supplied'}), /UNKNOWN_COMMAND_ARGUMENT/);
  }
  assert.throws(() => prepareMemoryCommand([]), /INVALID_COMMAND/);
  const args = input() as Partial<MemoryCommandInput>; delete args.command_id;
  assert.throws(() => prepareMemoryCommand(args), /ARGUMENT_REQUIRED/);
});

test('public commit schema accepts exactly full command or dual references', () => {
  const schema = enabledToolSchemas({memory: true}).find(s => s.name === 'paios_l3_commit')!;
  // This matrix checks parameter forms. Domain time formats retain their original authority.
  const validate = new Ajv({strict: true, strictRequired: false, validateFormats: false}).compile(schema.parameters);
  const refs = {proposal_ref: 'l3-proposal:owned:proposal', decision_ref: 'l3-decision:owned:decision'};
  assert.equal(validate(input()), true);
  assert.equal(validate(refs), true);
  for (const invalid of [{}, {proposal_ref: refs.proposal_ref}, {decision_ref: refs.decision_ref},
    {...input(), ...refs}, {...input(), proposal_ref: refs.proposal_ref}, {...refs, command_id: 'command'}])
    assert.equal(validate(invalid), false);
  for (const key of ['principal_id', 'run_id', 'session_id', 'authenticated', 'authorization', 'authorize', 'consent_ref']) {
    assert.equal(validate({...input(), [key]: 'forged'}), false);
    assert.equal(validate({...refs, [key]: 'forged'}), false);
  }
  const incomplete = input() as unknown as {assertion: Partial<MemoryCommandInput['assertion']>};
  delete incomplete.assertion.evidence_refs;
  assert.equal(validate(incomplete), false);
  schema.parameters.oneOf!.push({required: ['authorize']});
  (schema.parameters.properties.assertion as {required: string[]}).required.push('authorize');
  const fresh = enabledToolSchemas({memory: true}).find(s => s.name === 'paios_l3_commit')!;
  assert.equal(fresh.parameters.oneOf!.length, 2);
  assert.equal((fresh.parameters.properties.assertion as {required: string[]}).required.includes('authorize'), false);
});


test('place contracts bound history and require exact geofence operations and forget confirmation', () => {
  const schemas = enabledToolSchemas({memory: false, places: true});
  assert.deepEqual(schemas.slice(-3).map(s => s.name), ['paios_place_history', 'paios_geofences', 'paios_place_forget']);
  const ajv = new Ajv({strict: true, strictRequired: false, validateFormats: false});
  const history = ajv.compile(schemas.find(s => s.name === 'paios_place_history')!.parameters);
  assert.equal(history({view: 'visits', time_zone: 'Asia/Shanghai', place_id: 'wgs84:30.000,120.000', cursor: 0, limit: 100}), true);
  for (const args of [{view: 'visits'}, {view: 'unknown', time_zone: 'UTC'},
    {view: 'visits', time_zone: 'UTC', cursor: -1}, {view: 'visits', time_zone: 'UTC', limit: 101},
    {view: 'visits', time_zone: 'UTC', from: '2026-10-13T00:00:00+08:00'}]) assert.equal(history(args), false);
  const geofences = ajv.compile(schemas.find(s => s.name === 'paios_geofences')!.parameters);
  const region = {id: 'home', label: '家', latitude: 30, longitude: 120, radius_m: 100};
  for (const args of [{action: 'list'}, {action: 'set', region}, {action: 'remove', region_id: 'home'}]) assert.equal(geofences(args), true);
  for (const args of [{action: 'set'}, {action: 'remove'}, {action: 'list', region},
    {action: 'set', region, region_id: 'home'}, {action: 'set', region: {...region, label: 'home'}},
    {action: 'set', region: {...region, latitude: 91}}, {action: 'set', region: {...region, radius_m: 1001}}]) assert.equal(geofences(args), false);
  const forget = ajv.compile(schemas.find(s => s.name === 'paios_place_forget')!.parameters);
  assert.equal(forget({confirm: true}), true);
  for (const args of [{}, {confirm: false}, {confirm: true, principal_id: 'forged'}]) assert.equal(forget(args), false);
});

test('exact L5 owner deletion stays enabled without optional visual indexes and rejects mixed scopes',()=>{
  const schema=enabledToolSchemas({memory:false}).find(tool=>tool.name==='paios_visual_delete')!;
  const validate=new Ajv({strict:false,formats:{'date-time':true}}).compile(schema.parameters),ref=`l5:${'a'.repeat(64)}`;
  assert.equal(validate({raw_refs:[ref]}),true);
  assert.equal(validate({raw_refs:[ref,`l5-quarantine:${'b'.repeat(64)}`]}),true);
  assert.equal(validate({from:'2026-10-14T00:00:00Z',until:'2026-10-15T00:00:00Z'}),true);
  assert.equal(validate({raw_refs:[ref],from:'2026-10-14T00:00:00Z',until:'2026-10-15T00:00:00Z'}),false);
  assert.equal(validate({raw_refs:[]}),false);assert.equal(validate({raw_refs:['foreign-ref']}),false);
});

test('avatar schema requires CAS for approved-look changes and rejects forged identity or confirmation',()=>{
  const schema=enabledToolSchemas({memory:false}).find(tool=>tool.name==='paios_avatar')!;
  const validate=new Ajv({strict:false}).compile(schema.parameters);
  for(const args of [{action:'get'},{action:'list'},{action:'change',look_id:'formal',expected_version:0}])assert.ok(validate(args));
  for(const args of [{action:'change',look_id:'formal'},{action:'change',expected_version:0},
    {action:'change',look_id:'formal',expected_version:-1},{action:'get',look_id:'formal'},
    {action:'change',look_id:'formal',expected_version:0,principal_id:'other'},
    {action:'change',look_id:'formal',expected_version:0,owner_confirmed:true}])assert.equal(validate(args),false);
});
