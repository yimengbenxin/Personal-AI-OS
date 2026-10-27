#!/usr/bin/env node
import {parseArgs} from 'node:util';
import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {check} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/contracts.ts';
import {ModelSettingsAuthority} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings.ts';
import {callIntentFallbackUpdate} from '../../01-product-half-finished/backend/services/personal-aios-integration/src/model-settings-call-intent.ts';

/** Offline deployment migration. It stages a revision; the running service owns activation/ACK. */
function main(){
  const {values}=parseArgs({options:{directory:{type:'string'},master:{type:'string'},environment:{type:'string'},
    profile:{type:'string'},'expected-revision':{type:'string'},'principal-id':{type:'string'},
    'allow-private-host':{type:'string',multiple:true},apply:{type:'boolean'}}});
  for(const key of ['directory','master','environment','profile','expected-revision','principal-id'] as const)
    check(values[key],'MODEL_SETTINGS_CLI_ARGUMENT_REQUIRED');
  const expected_revision=Number(values['expected-revision']);
  check(Number.isSafeInteger(expected_revision)&&expected_revision>0,'MODEL_SETTINGS_CLI_REVISION_INVALID');
  check(existsSync(join(values.directory!,'model-settings.sqlite3')),'MODEL_SETTINGS_CLI_AUTHORITY_REQUIRED');
  const authority=ModelSettingsAuthority.open(values.directory!,{environment_id:values.environment!,master_key_file:values.master!,
    allow_private_hosts:values['allow-private-host']});
  try{
    check(authority.read().desired===expected_revision,'MODEL_SETTINGS_REVISION_CONFLICT',409);
    const role=callIntentFallbackUpdate(authority.readRevision(expected_revision).snapshot,values.profile!);
    if(role&&values.apply){
      const brain=authority.read().groups.brain;
      check(brain.status==='effective'&&brain.desired===brain.effective,'MODEL_SETTINGS_BUSY',409);
      const actor={principal_id:values['principal-id']!,device_id:'deployment-rq115'};
      const draft=authority.draft(actor,{expected_revision,roles:[role]});
      authority.commitDraft(actor,draft.draft_id,`rq115-${values.profile}-${expected_revision}`);
    }
    console.log(JSON.stringify({environment_id:authority.environment_id,profile:values.profile,
      expected_revision,changed:!!role,applied:!!role&&values.apply===true,
      ...(role?{role}:{}),desired:authority.read().desired,brain:authority.read().groups.brain}));
  }finally{authority.close();}
}
try{main();}catch(error){
  const message=error instanceof Error?error.message:'';
  console.error(/^MODEL_[A-Z_]+$/u.test(message)?message:'MODEL_SETTINGS_CALL_INTENT_MIGRATION_FAILED');
  process.exitCode=1;
}
