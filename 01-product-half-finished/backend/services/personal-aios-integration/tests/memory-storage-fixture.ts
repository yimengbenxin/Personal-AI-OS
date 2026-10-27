import {sha256} from '../src/contracts.ts';
import type {StoragePort} from '../src/storage.ts';
import type {FinalSession} from '../src/session-records.ts';

// Immutable storage port for owner/state-machine tests. POSIX durability is exercised separately.
export class MemoryStorage implements StoragePort {
  private spaces=new Map<string,Map<string,Uint8Array>>();
  private space(namespace:string){
    let values=this.spaces.get(namespace);
    if(!values){values=new Map();this.spaces.set(namespace,values);}return values;
  }
  async publish(namespace:string,key:string,bytes:Uint8Array){
    const values=this.space(namespace);if(!values.has(key))values.set(key,bytes.slice());
    return values.get(key)!.slice();
  }
  async read(namespace:string,key:string){
    const bytes=this.space(namespace).get(key);
    if(!bytes)throw Object.assign(new Error(`missing ${namespace}/${key}`),{code:'ENOENT'});
    return bytes.slice();
  }
  async list(namespace:string){return [...this.space(namespace).keys()].sort();}
  async removePending(key:string){this.space('admission-inputs').delete(key);}
  async publishIngress(key:string,metadata:Uint8Array,hash:string,payload:Uint8Array,beforeWrite?:()=>Promise<void>){
    await beforeWrite?.();await this.publish('objects',hash,payload);await this.publish('raw-ingress',key,metadata);
  }
  async removeIngress(key:string){this.space('raw-ingress').delete(key);}
  async removeOriginals(records:{namespace:string;key:string}[]){for(const r of records)this.space(r.namespace).delete(r.key);}
  async publishObjectStream(chunks:AsyncIterable<Uint8Array>,beforePublish?:(key:string)=>Promise<void>){
    const parts:Uint8Array[]=[];for await(const chunk of chunks)parts.push(chunk);
    const bytes=Buffer.concat(parts),object_hash=sha256(bytes);await beforePublish?.(object_hash);await this.publish('objects',object_hash,bytes);
    return {object_hash,bytes:bytes.length};
  }
  async *readObjectRange(key:string,offset:number,bytes:number){yield (await this.read('objects',key)).slice(offset,offset+bytes);}
  async publishFinal(record:FinalSession){
    return JSON.parse(Buffer.from(await this.publish('session-finals',record.raw_ref.slice(3),Buffer.from(JSON.stringify(record)))).toString()) as FinalSession;
  }
  async readFinal(rawRef:string){
    try{return JSON.parse(Buffer.from(await this.read('session-finals',rawRef.slice(3))).toString()) as FinalSession;}
    catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return null;throw error;}
  }
}
