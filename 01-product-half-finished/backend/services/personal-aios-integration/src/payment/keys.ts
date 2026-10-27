import {createHash,createPublicKey,randomBytes,verify,generateKeyPairSync,diffieHellman,hkdfSync,createHmac,timingSafeEqual,type KeyObject} from 'node:crypto';
import {canonical,check} from '../contracts.ts';
import {hasTerminalCapability,type RegisteredDevice} from '../source-authority.ts';
import type {SignedInput,DeviceKey} from './contracts.ts';
import type {PaymentStore} from './store.ts';
export type ChallengePurpose='keys_register'|'phone_unlock'|'settings'|'approval'|'voiceprint_forget'|'model_settings'|'model_settings_publish_key';
export type StatementPurpose=ChallengePurpose|'payment_decide'|'mac_pairing';
export interface VerifiedStatement {statement:Record<string,unknown>;commit<T>(mutation:()=>T):T}
const fields:Record<StatementPurpose,string[]>={
  model_settings:['action','draft_id','expected_revision','change_sha256','expires_at_ms','principal_id'],
  model_settings_publish_key:['principal_id','key_sha256'],
  mac_pairing:['public_key_sha256'],
  keys_register:['role','key_sha256'],phone_unlock:[],payment_decide:['payment_id','decision','amount_fen','payee_key'],
  settings:['policy_version','change'],approval:['approval_id','kind','target_device_id','decision'],voiceprint_forget:['channel'],
};
export const paymentNonce=()=>randomBytes(32).toString('base64url');
function decode(value:unknown,max:number):Buffer {
  check(typeof value==='string'&&value.length>0&&value.length<=Math.ceil(max/3)*4&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value),'PAYMENT_SIGNATURE_INVALID',403);
  const bytes=Buffer.from(value,'base64');check(bytes.length<=max&&bytes.toString('base64')===value,'PAYMENT_SIGNATURE_INVALID',403);return bytes;
}
export function paymentPublicKey(encoded:string):KeyObject {
  const bytes=decode(encoded,65);check(bytes.length===65&&bytes[0]===4,'PAYMENT_SIGNATURE_INVALID',403);
  try {return createPublicKey({key:{kty:'EC',crv:'P-256',x:bytes.subarray(1,33).toString('base64url'),y:bytes.subarray(33).toString('base64url')},format:'jwk'});}
  catch {check(false,'PAYMENT_SIGNATURE_INVALID',403);}
}
function signatureValid(bytes:Buffer,key:KeyObject,sig:Buffer):boolean {
  try {return verify('sha256',bytes,{key,dsaEncoding:'der'},sig);}
  catch {check(false,'PAYMENT_SIGNATURE_INVALID',403);}
}
/** Verifies received bytes; nonce consumption is coupled to a successful synchronous mutation. */
export class PaymentKeys {
  private readonly challenges=new Map<string,{device:string;principal:string;purpose:ChallengePurpose;until:number;identity_key?:string;mac_key?:Buffer}>();
  private readonly now:()=>number;
  private readonly options:{store:PaymentStore;challenge_ttl_s:number;revalidate:(s:RegisteredDevice)=>Promise<RegisteredDevice>;now?:()=>number};
  constructor(options:{store:PaymentStore;challenge_ttl_s:number;revalidate:(s:RegisteredDevice)=>Promise<RegisteredDevice>;now?:()=>number}) {this.options=options;this.now=options.now??Date.now;}
  private async phone(source:RegisteredDevice):Promise<void> {
    const current=await this.options.revalidate(source);
    check(current.device_type==='phone'&&hasTerminalCapability(current,'owner_unlock'),'PAYMENT_SETTINGS_DEVICE_REQUIRED',403);
  }
  private prune():void {for(const [nonce,c] of this.challenges)if(c.until<=this.now())this.challenges.delete(nonce);}
  async challenge(source:RegisteredDevice,purpose:ChallengePurpose):Promise<{nonce:string;expires_in_ms:number;server_public_key_b64?:string;algorithm?:string}> {
    if(purpose==='model_settings_publish_key'){
      source=await this.options.revalidate(source);
      check(source.device_type==='mac'&&source.recipient_public_key,'MODEL_SETTINGS_MAC_IDENTITY_REQUIRED',403);
    }else if(purpose==='model_settings')await this.assertModelSettings(source);else await this.phone(source);check(purpose as string!=='payment_decide'&&Object.hasOwn(fields,purpose),'PAYMENT_CHALLENGE_PURPOSE_INVALID');this.prune();
    const own=[...this.challenges].filter(([,c])=>c.device===source.device_id&&c.principal===source.principal_id);
    if(own.length>=8)this.challenges.delete(own[0]![0]);
    const nonce=paymentNonce(),ttl=this.options.challenge_ttl_s*1000;
    const challenge={device:source.device_id,principal:source.principal_id,purpose,until:this.now()+ttl};
    if(purpose==='model_settings_publish_key'){
      const identity=source.recipient_public_key!,publicKey=createPublicKey({key:{kty:'OKP',crv:'X25519',x:identity},format:'jwk'});
      const ephemeral=generateKeyPairSync('x25519'),shared=diffieHellman({privateKey:ephemeral.privateKey,publicKey});
      const mac_key=Buffer.from(hkdfSync('sha256',shared,Buffer.from(nonce,'base64url'),Buffer.from('paios.model_settings.publish_key.v1'),32));
      this.challenges.set(nonce,{...challenge,identity_key:identity,mac_key});
      return {nonce,expires_in_ms:ttl,server_public_key_b64:Buffer.from(ephemeral.publicKey.export({format:'jwk'}).x!,'base64url').toString('base64'),algorithm:'X25519-HKDF-SHA256-HMAC-SHA256'};
    }
    this.challenges.set(nonce,challenge);return {nonce,expires_in_ms:ttl};
  }
  registered(source:RegisteredDevice,role:DeviceKey['role']):DeviceKey|undefined {
    return this.options.store.db.prepare('SELECT * FROM device_keys WHERE device_id=? AND principal_id=? AND role=? AND revoked_at_ms IS NULL').get(source.device_id,source.principal_id,role) as unknown as DeviceKey|undefined;
  }
  private signed(input:SignedInput,key:KeyObject):{bytes:Buffer;statement:Record<string,unknown>} {
    check(input.statement_b64&&input.signature_b64,'PAYMENT_SIGNATURE_REQUIRED',403);
    const bytes=decode(input.statement_b64,2048),sig=decode(input.signature_b64,80);
    check(signatureValid(bytes,key,sig),'PAYMENT_SIGNATURE_INVALID',403);
    let statement:unknown;try {statement=JSON.parse(bytes.toString('utf8'));}catch {check(false,'PAYMENT_SIGNATURE_INVALID',403);}
    check(statement!==null&&typeof statement==='object'&&!Array.isArray(statement),'PAYMENT_SIGNATURE_INVALID',403);
    return {bytes,statement:statement as Record<string,unknown>};
  }
  private bind(source:RegisteredDevice,purpose:StatementPurpose,statement:Record<string,unknown>,expected:Record<string,unknown>,externalNonce?:string):VerifiedStatement {
    const expectedKeys=['purpose','device_id','nonce',...fields[purpose]].sort();
    check(canonical(Object.keys(statement).sort())===canonical(expectedKeys)&&statement.purpose===purpose&&statement.device_id===source.device_id,'PAYMENT_SIGNATURE_INVALID',403);
    check(canonical(Object.keys(expected).sort())===canonical(fields[purpose].slice().sort()),'PAYMENT_STATEMENT_EXPECTATION_INVALID',500);
    for(const name of fields[purpose])check(canonical(statement[name])===canonical(expected[name]),'PAYMENT_SIGNATURE_INVALID',403);
    if(purpose==='model_settings')check(statement.principal_id===source.principal_id&&Number.isSafeInteger(statement.expires_at_ms)&&(externalNonce!==undefined||Number(statement.expires_at_ms)>this.now()),'MODEL_SETTINGS_SIGNATURE_EXPIRED',403);
    const nonce=statement.nonce;check(typeof nonce==='string'&&/^[A-Za-z0-9_-]{43}$/.test(nonce),'PAYMENT_SIGNATURE_INVALID',403);
    const live=()=>{const c=this.challenges.get(nonce);check(externalNonce!==undefined?nonce===externalNonce:c&&c.device===source.device_id&&c.principal===source.principal_id&&c.purpose===purpose&&c.until>this.now(),'PAYMENT_CHALLENGE_INVALID',403);};
    live();let used=false;
    return {statement,commit:<T>(mutation:()=>T):T=>{check(!used,'PAYMENT_CHALLENGE_INVALID',403);live();const result=mutation();used=true;if(externalNonce===undefined)this.challenges.delete(nonce);return result;}};
  }
  async verify(source:RegisteredDevice,purpose:StatementPurpose,input:SignedInput,expected:Record<string,unknown>,externalNonce?:string):Promise<VerifiedStatement> {
    if(purpose==='model_settings')await this.assertModelSettings(source);else await this.phone(source);
    const role=purpose==='model_settings'&&source.device_type==='mac'?'model_settings':purpose==='payment_decide'?'device':'user',key=this.registered(source,role);
    check(key,'PAYMENT_DEVICE_KEY_UNKNOWN',403);
    const {statement}=this.signed(input,paymentPublicKey(key.public_x963_b64));return this.bind(source,purpose,statement,expected,externalNonce);
  }
  async register(source:RegisteredDevice,input:SignedInput&{role:'device'|'user';public_x963_b64:string;device_signature_b64?:string}):Promise<void> {
    await this.phone(source);check(input.role==='device'||input.role==='user','PAYMENT_KEYS_ROLE_INVALID');
    check(!this.options.store.db.prepare('SELECT 1 FROM device_keys WHERE device_id=? AND role=?').get(source.device_id,input.role),'PAYMENT_KEYS_ALREADY_REGISTERED',409);
    const key=paymentPublicKey(input.public_x963_b64),{bytes,statement}=this.signed(input,key),key_sha256=createHash('sha256').update(decode(input.public_x963_b64,65)).digest('hex');
    if(input.role==='user'){
      const device=this.registered(source,'device');check(device,'PAYMENT_DEVICE_KEY_UNKNOWN',403);
      check(input.device_signature_b64,'PAYMENT_SIGNATURE_REQUIRED',403);
      check(signatureValid(bytes,paymentPublicKey(device.public_x963_b64),decode(input.device_signature_b64,80)),'PAYMENT_SIGNATURE_INVALID',403);
    }
    const verified=this.bind(source,'keys_register',statement,{role:input.role,key_sha256});
    verified.commit(()=>this.options.store.tx(()=>{
      this.options.store.db.prepare('INSERT INTO device_keys(device_id,role,principal_id,public_x963_b64,created_at_ms,revoked_at_ms) VALUES(?,?,?,?,?,NULL)').run(source.device_id,input.role,source.principal_id,input.public_x963_b64,this.now());
      this.options.store.event({at_ms:this.now(),principal_id:source.principal_id,kind:'keys_registered',actor:'owner_phone',device_id:source.device_id,data:{device_id:source.device_id,role:input.role,key_sha256}});
    }));
  }
  async assertModelSettings(source:RegisteredDevice):Promise<void> {
    const current=await this.options.revalidate(source);
    if(current.device_type==='mac')check(this.registered(current,'model_settings'),'MODEL_SETTINGS_MAC_UNAUTHORIZED',403);
    else check(current.device_type==='phone'&&hasTerminalCapability(current,'owner_unlock'),'PAYMENT_SETTINGS_DEVICE_REQUIRED',403);
  }
  /** Proof uses the existing paired X25519 private key; publication grants no signing permission. */
  async publishModelSettings(source:RegisteredDevice,input:SignedInput&{public_x963_b64:string}):Promise<void> {
    source=await this.options.revalidate(source);
    check(source.device_type==='mac'&&source.recipient_public_key,'MODEL_SETTINGS_MAC_IDENTITY_REQUIRED',403);
    paymentPublicKey(input.public_x963_b64);
    const bytes=decode(input.statement_b64,2048),signature=decode(input.signature_b64,32);
    let statement:Record<string,unknown>;try{statement=JSON.parse(bytes.toString('utf8'));}catch{check(false,'PAYMENT_SIGNATURE_INVALID',403);}
    check(statement&&typeof statement==='object'&&!Array.isArray(statement),'PAYMENT_SIGNATURE_INVALID',403);
    const challenge=this.challenges.get(String(statement.nonce));
    check(challenge?.mac_key&&challenge.identity_key===source.recipient_public_key,'PAYMENT_CHALLENGE_INVALID',403);
    const expectedSignature=createHmac('sha256',challenge.mac_key).update(bytes).digest();
    check(signature.length===expectedSignature.length&&timingSafeEqual(signature,expectedSignature),'PAYMENT_SIGNATURE_INVALID',403);
    const key_sha256=createHash('sha256').update(decode(input.public_x963_b64,65)).digest('hex');
    const verified=this.bind(source,'model_settings_publish_key',statement,{principal_id:source.principal_id,key_sha256});
    verified.commit(()=>this.options.store.tx(()=>{
      this.options.store.db.prepare(`INSERT INTO device_keys(device_id,role,principal_id,public_x963_b64,created_at_ms,revoked_at_ms)
        VALUES(?,'model_settings_pending',?,?,?,NULL) ON CONFLICT(device_id,role) DO UPDATE SET
        principal_id=excluded.principal_id,public_x963_b64=excluded.public_x963_b64,created_at_ms=excluded.created_at_ms,revoked_at_ms=NULL`)
        .run(source.device_id,source.principal_id,input.public_x963_b64,this.now());
      this.options.store.event({at_ms:this.now(),principal_id:source.principal_id,kind:'model_settings_key_published',actor:'owner_mac',device_id:source.device_id,
        data:{device_id:source.device_id,purpose:'model_settings',key_sha256}});
    }));
  }
  pendingModelSettings(source:RegisteredDevice):DeviceKey|undefined {return this.registered(source,'model_settings_pending');}
  async registerModelSettings(source:RegisteredDevice,target:RegisteredDevice,public_x963_b64:string,verified:VerifiedStatement,mutation?:()=>void,reconcileApproval?:()=>void):Promise<void> {
    await this.phone(source);const current=await this.options.revalidate(target);
    check(current.device_type==='mac'&&current.principal_id===source.principal_id,'MODEL_SETTINGS_MAC_TARGET_INVALID',403);
    paymentPublicKey(public_x963_b64);
    if(!reconcileApproval)check(this.pendingModelSettings(current)?.public_x963_b64===public_x963_b64,'MODEL_SETTINGS_MAC_KEY_CHANGED',409);
    check(verified.statement.purpose==='model_settings'&&verified.statement.action==='authorize_mac'&&verified.statement.device_id===source.device_id,'PAYMENT_SIGNATURE_INVALID',403);
    verified.commit(()=>this.options.store.tx(()=>{
      reconcileApproval?.();
      this.options.store.db.prepare(`INSERT INTO device_keys(device_id,role,principal_id,public_x963_b64,created_at_ms,revoked_at_ms)
        VALUES(?,'model_settings',?,?,?,NULL) ON CONFLICT(device_id,role) DO UPDATE SET
        principal_id=excluded.principal_id,public_x963_b64=excluded.public_x963_b64,created_at_ms=excluded.created_at_ms,revoked_at_ms=NULL`)
        .run(current.device_id,current.principal_id,public_x963_b64,this.now());
      this.options.store.event({at_ms:this.now(),principal_id:source.principal_id,kind:'model_settings_mac_authorized',actor:'owner_phone',device_id:source.device_id,
        data:{device_id:current.device_id,purpose:'model_settings',key_sha256:createHash('sha256').update(Buffer.from(public_x963_b64,'base64')).digest('hex')}});
      mutation?.();
    }));
  }
  clear(source?:RegisteredDevice):void {for(const [nonce,c] of this.challenges)if(!source||c.device===source.device_id&&c.principal===source.principal_id)this.challenges.delete(nonce);}
}
