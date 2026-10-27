import type {PersonalAIOSRuntime} from '../runtime.ts';
export type CompanionValue=Awaited<ReturnType<PersonalAIOSRuntime['result']>>;
export interface CompanionNotice {key:string;principal_id:string;device_id:string;session_id:string;expires_at:number;signal:AbortSignal}
interface CompanionPorts {
  available(notice:CompanionNotice):Promise<boolean>;
  subscribe(notice:CompanionNotice,receive:(value:CompanionValue)=>Promise<void>):Promise<()=>void>;
  publish(notice:CompanionNotice,value:CompanionValue):Promise<void>;
  error(error:unknown):void;
}
/** Delivery adapter only. Existing OUT owns synthesis, epochs, cancellation, rendered and played receipts. */
export class CompanionOutreach {
  private readonly ports:CompanionPorts;private readonly now:()=>number;
  private readonly notices=new Map<string,{notice:CompanionNotice;stop?:()=>void;opening:boolean;abort:()=>void}>();private ticking=false;
  constructor(ports:CompanionPorts,now=Date.now){this.ports=ports;this.now=now;}
  async offer(notice:CompanionNotice):Promise<'pending'|'ignored'>{
    if(notice.signal.aborted||this.now()>=notice.expires_at)return 'ignored';
    if(!this.notices.has(notice.key)){
      const abort=()=>this.retire(notice.key);this.notices.set(notice.key,{notice,opening:false,abort});notice.signal.addEventListener('abort',abort,{once:true});
    }
    await this.tick();return 'pending'; // A publish/write completion never fabricates rendered or played.
  }
  private retire(key:string){const item=this.notices.get(key);if(item){item.notice.signal.removeEventListener('abort',item.abort);item.stop?.();}this.notices.delete(key);}
  async tick(){if(this.ticking)return;this.ticking=true;
    try{for(const [key,item] of [...this.notices]){
      if(item.notice.signal.aborted||this.now()>=item.notice.expires_at){this.retire(key);continue;}
      if(item.stop||item.opening||!await this.ports.available(item.notice))continue;item.opening=true;
      try{const stop=await this.ports.subscribe(item.notice,async value=>{
        if(!this.notices.has(key)||item.notice.signal.aborted||this.now()>=item.notice.expires_at)return;
        if(!await this.ports.available(item.notice)){item.stop?.();delete item.stop;return;}
        const result=value.result,text=result.reply_text.trim();
        if(result.reply_mode==='none'||!text||Array.from(text).length>48){this.retire(key);return;}
        if(!result.output_plan.some(plan=>plan!==null&&typeof plan==='object'&&!Array.isArray(plan)&&plan.target_device_id===item.notice.device_id))return;
        await this.ports.publish(item.notice,value);
      });if(this.notices.has(key))item.stop=stop;else stop();}
      catch(error){this.ports.error(error);}finally{item.opening=false;}
    }}finally{this.ticking=false;}
  }
  close(){for(const key of [...this.notices.keys()])this.retire(key);}
}
