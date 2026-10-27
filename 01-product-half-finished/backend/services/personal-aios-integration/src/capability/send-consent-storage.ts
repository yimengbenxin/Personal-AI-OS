import {canonical,digest} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import {SEND_CONSENTS,type SendIdentity} from './send-identity.ts';

/** Keep the established decision/receipt service. Its catalog send scopes have a distinct durable key space. */
export function sendConsentStorage(storage:StoragePort,identity:SendIdentity|undefined):StoragePort {
  if(!identity)return storage;
  const port=Object.create(storage) as StoragePort;
  const project=async(saved:Uint8Array)=>{
    const record=JSON.parse(Buffer.from(saved).toString('utf8'));
    // Only injective legacy WeChat kinds can be projected without widening an old grant.
    if(!record.run_id&&!record.tool_call_id)for(const alias of identity.legacy??[]){
      const scope={principal_id:record.principal_id,kind:'send',...alias};
      await storage.publish('effect-consents',digest(scope),Buffer.from(canonical({...record,...scope,send_consent_projection:1})));
    }
    return saved;
  };
  port.read=async(namespace,key)=>namespace==='effect-consents'?project(await storage.read(SEND_CONSENTS,key)):storage.read(namespace,key);
  port.publish=async(namespace,key,bytes)=>namespace==='effect-consents'?project(await storage.publish(SEND_CONSENTS,key,bytes)):
    storage.publish(namespace,key,bytes);
  return port;
}
