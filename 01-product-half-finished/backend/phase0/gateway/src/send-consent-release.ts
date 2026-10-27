import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {loadHostConfiguration} from '../../../services/personal-aios-integration/src/host-configuration.ts';
import {PosixStorage} from '../../../services/personal-aios-integration/src/storage.ts';
import {migrateSendConsents} from '../../../services/personal-aios-integration/src/capability/send-consent-migration.ts';
import {parseConfiguredOwnerPolicy} from './rayneo-demo-owner-projection.ts';
import type {SendDirectory} from '../../../../../capability/contracts/send-recipient.ts';

async function optional(path:string){
  try{return JSON.parse(await readFile(path,'utf8'));}
  catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;return {};}
}
/** Use the same native directory + owner-maintained aliases that native preparation reads, mounted read-only. */
export async function releaseSendConsents(configPath:string){
  const config=await loadHostConfiguration(configPath) as {storage_root:string;core_profile?:{native_profile_home?:string};
    product_resources:{owner_policy_file:string}};
  const principal=parseConfiguredOwnerPolicy(JSON.parse(await readFile(config.product_resources.owner_policy_file,'utf8'))).userId;
  const home=config.core_profile?.native_profile_home??'/opt/data';
  const directory=await optional(join(home,'channel_directory.json')) as SendDirectory;
  directory.platforms??={};
  const aliases=await optional(join(home,'channel_aliases.json')) as Record<string,Record<string,string>>;
  for(const [channel,entries] of Object.entries(aliases))for(const [id,name] of Object.entries(entries)){
    const rows=directory.platforms[channel]??=[];
    const row=rows.find(row=>row.id===id);
    if(row)row.name=name;else rows.push({id,name});
  }
  return migrateSendConsents(new PosixStorage(config.storage_root),principal,directory);
}
