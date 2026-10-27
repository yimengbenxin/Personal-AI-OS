import {DEFAULT_TIME_ZONE,timeZoneName} from '../deployment-time.ts';
import type {DatabaseSync} from 'node:sqlite';
import {digest,principalAttribution,type CaptureLocation,type ProcessedEvent} from '../contracts.ts';
import {inTransaction,openOwnerDatabase,resetOwnerDatabase,resetRowCounts} from '../owner-db.ts';
import {join} from 'node:path';
import type {StoredSample} from '../health/store.ts';
import type {ContactsStore} from '../contacts/store.ts';
import type {RegisteredDevice} from '../source-authority.ts';

/** The display name explicitly designated by the owner's native memory. */
export function ownerMemoryName(entries: readonly string[]): string | undefined {
  return entries.map(e=>/(?:称呼|名字)[:：]\s*([^\s，。,;；]{1,16})/u.exec(e)?.[1]).find(Boolean);
}
/** Host services used by the deterministic fall safety flow. */
export interface CarePorts {
  reach(principal:string,device:string,id:string,text:string,at_ms?:number):Promise<{spoken:string}|void>;
  sms(message:{principal_id:string;id:string;to:string;text:string}):Promise<void>;
  locate(principal:string,device:string,refresh?:boolean):Promise<{current:CaptureLocation|undefined;last_known:CaptureLocation|undefined}>;
  memory():Promise<string[]>;
  contacts:ContactsStore|undefined;
}
/** A fall the owner has not answered for this long goes to the emergency contacts. */
export const FALL_ESCALATION_MS=60_000;
/** Older signals are history (a health backlog, reprocessed audio), never a check-in. */
const FRESH_MS=15*60_000,RECENT_MS=72*3600_000;
const SCHEMA='paios.care-store.v1';
const DDL=`
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL) STRICT;
CREATE TABLE IF NOT EXISTS events(care_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,device_id TEXT NOT NULL,at_ms INTEGER NOT NULL,
  reached INTEGER NOT NULL DEFAULT 0,answered INTEGER NOT NULL DEFAULT 0) STRICT;
CREATE INDEX IF NOT EXISTS events_time ON events(principal_id,at_ms);
CREATE TABLE IF NOT EXISTS escalations(care_id TEXT PRIMARY KEY REFERENCES events(care_id),principal_id TEXT NOT NULL,device_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL,due_ms INTEGER NOT NULL,location TEXT,state TEXT NOT NULL CHECK(state IN ('armed','cancelled','firing','fired')),outcome TEXT) STRICT;
CREATE TABLE IF NOT EXISTS timeline(principal_id TEXT NOT NULL,at_ms INTEGER NOT NULL,line TEXT NOT NULL) STRICT;
CREATE INDEX IF NOT EXISTS timeline_time ON timeline(principal_id,at_ms);
CREATE TABLE IF NOT EXISTS decisions(care_id TEXT PRIMARY KEY,principal_id TEXT NOT NULL,input TEXT NOT NULL,payload TEXT) STRICT;`;
const clip=(text:string,limit:number)=>{const all=Array.from(text.replace(/\s+/gu,' ').trim());
  return all.length>limit?`${all.slice(0,limit-1).join('')}…`:all.join('');};
/** Deployment-local time for the owner and their contacts. */
const stamp=(ms:number,timeZone:string)=>new Intl.DateTimeFormat('zh-CN',{timeZone,month:'numeric',day:'numeric',weekday:'short',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23',timeZoneName:'shortOffset'}).format(ms);
const locationLine=(zone:string,fix:CaptureLocation|undefined,current=false)=>fix?
  `${current?'当前位置':'最后已知位置'}（${timeZoneName(zone)}${new Intl.DateTimeFormat('zh-CN',{timeZone:zone,year:'numeric',month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'}).format(Date.parse(fix.observed_at))}）：`+
  `${fix.place?`${fix.place}，`:''}https://uri.amap.com/marker?position=${fix.longitude},${fix.latitude}&coordinate=wgs84（误差约${Math.round(fix.accuracy_m)}米）`:
  '位置未知（手机最近没有定位）';
const failed=(code:string)=>(error:unknown)=>console.error(code,error instanceof Error?error.message:'unknown');

/** Durable fall safety: check in immediately, then text emergency contacts after 60 seconds without an owner response.
 * Armed escalations resume after restart. Interrupted alerts reuse the executor's stable errand ids. */
export class CareAuthority {
  static resetConversation(directory:string,cutoff:number,apply=false) {
    return resetOwnerDatabase(join(directory,'care.sqlite'),[SCHEMA],apply,db=>{
      const rows=db.prepare('SELECT rowid,* FROM timeline').all();
      const selected=(r:Record<string,unknown>)=>Number(r.at_ms)<cutoff&&/^(主人：|依米[：（]|关心未送达：|关心送达未确认：)/u.test(String(r.line));
      const result=resetRowCounts('care-conversation',rows,selected);
      if(apply)for(const row of rows.filter(selected))db.prepare('DELETE FROM timeline WHERE rowid=?').run(Number(row.rowid));
      return result;
    });
  }
  private readonly time_zone:string;
  private readonly db:DatabaseSync;private readonly now:()=>number;
  private readonly timers=new Map<string,ReturnType<typeof setTimeout>>();
  private ports:CarePorts|undefined;
  private constructor(db:DatabaseSync,now:()=>number,time_zone:string){this.db=db;this.now=now;this.time_zone=time_zone;}
  static open(directory:string,now:()=>number=Date.now,time_zone=DEFAULT_TIME_ZONE):CareAuthority {
    return new CareAuthority(openOwnerDatabase(directory,'care.sqlite',DDL,SCHEMA,'CARE_STORE'),now,time_zone);
  }
  attach(ports:CarePorts):void {
    this.ports=ports;
    this.db.prepare("UPDATE timeline SET line=replace(line,'依米（送达中）：','关心送达未确认：') WHERE line LIKE '依米（送达中）：%'").run();
    for(const e of this.db.prepare("SELECT care_id,state,due_ms FROM escalations WHERE state IN ('armed','firing')").all() as {care_id:string;state:string;due_ms:number}[])
      if(e.state==='armed'){this.arm(e.care_id,e.due_ms);void this.checkin(e.care_id).catch(failed('CARE_CHECKIN_FAILED'));}else void this.alert(e.care_id).catch(failed('CARE_ALERT_FAILED'));
  }
  close():void {
    for(const timer of this.timers.values())clearTimeout(timer);
    this.timers.clear();this.ports=undefined;if(this.db.isOpen)this.db.close();
  }
  /** A fresh positive Watch fall sample arms safety once. Other health observations belong to the main timeline. */
  synced(source:RegisteredDevice,_session:string,metric:string,samples:StoredSample[]):void {
    if(metric!=='numberOfTimesFallen')return;
    for(const sample of samples)if(sample.value!==null&&sample.value>0)
      void this.fall(source,sample).catch(failed('CARE_SIGNAL_FAILED'));
  }
  private async fall(source:RegisteredDevice,sample:StoredSample):Promise<void> {
    const ports=this.ports,{principal_id:principal,device_id:device}=source,at=sample.end_ms;
    if(!ports||at>this.now()||this.now()-at>FRESH_MS)return;
    const care_id=`care:${digest([principal,`fall:${sample.sample_id}`]).slice(0,24)}`,due=this.now()+FALL_ESCALATION_MS;
    const position=await ports.locate(principal,device),location=position.current??position.last_known;
    if(!this.db.isOpen)return;
    const fresh=inTransaction(this.db,()=>{
      if(!this.db.prepare('INSERT INTO events(care_id,principal_id,device_id,at_ms) VALUES(?,?,?,?) ON CONFLICT DO NOTHING').run(care_id,principal,device,at).changes)return false;
      this.note(principal,at,'手表检测到摔倒');
      if(this.db.prepare('SELECT 1 FROM meta WHERE key=? AND CAST(value AS INTEGER)>=?').get(`owner-response:${principal}`,at)){
        this.db.prepare('UPDATE events SET answered=1 WHERE care_id=?').run(care_id);
        this.note(principal,at,'主人已在摔倒后回应，没有通知紧急联系人');return false;
      }
      this.db.prepare("INSERT INTO escalations(care_id,principal_id,device_id,at_ms,due_ms,location,state) VALUES(?,?,?,?,?,?,'armed')")
        .run(care_id,principal,device,at,due,location?JSON.stringify(location):null);
      return true;
    });
    if(fresh){this.arm(care_id,due);await this.checkin(care_id);}
  }
  private async checkin(care_id:string):Promise<void> {
    const e=this.db.prepare('SELECT principal_id,device_id FROM events WHERE care_id=?').get(care_id) as
      {principal_id:string;device_id:string};
    if(this.db.prepare('SELECT 1 FROM meta WHERE key=?').get(`${care_id}:checkin`))return;
    const {call}=await this.owner(e.principal_id);
    if(!this.db.isOpen)return;
    await this.say(care_id,e.principal_id,e.device_id,`${care_id}:checkin`,`${call?`${call}，`:''}你还好吗？手表说你可能摔倒了。没事就回我一句；1分钟没有回应，我会通知你的紧急联系人。`);
  }
  /** Only an attributed owner response can cancel fall safety; use the capture's authoritative event time. */
  admitted(d:ProcessedEvent):void {
    if(principalAttribution(d)===null)return;
    const r=d.time_range,at=r.timebase_id==='utc_epoch_ms'||r.timebase_id==='utc_unix_ms'?
      r.kind==='instant'?r.at_ms:r.end_ms:Date.parse(d.captured_at);
    const c=d.content as {text?:unknown;transcript?:unknown;wake_request?:{text?:unknown};app_event?:{kind?:unknown;user?:unknown;request_text?:unknown}};
    if(c.app_event?.kind==='voice_turn'&&(typeof c.app_event.user!=='string'||!c.app_event.user.trim()))return;
    const words=[c.text,c.transcript,c.wake_request?.text,c.app_event?.user,c.app_event?.request_text].find(v=>typeof v==='string') as string|undefined;
    this.respond(d.principal_id,at,words);
  }
  /** The owner responded at `at` (UTC ms): every escalation armed for an earlier fall stands down; `words` answer 依米's
   *  recent reach-outs. */
  respond(principal:string,at:number,words?:string):{cancelled:number} {
    const stood=inTransaction(this.db,()=>{
      this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value '+
        'WHERE CAST(excluded.value AS INTEGER)>CAST(meta.value AS INTEGER)').run(`owner-response:${principal}`,String(at));
      return this.db.prepare("UPDATE escalations SET state='cancelled',outcome='主人有回应' WHERE principal_id=? AND state='armed' AND at_ms<=? RETURNING care_id")
        .all(principal,at) as {care_id:string}[];
    });
    for(const {care_id} of stood){clearTimeout(this.timers.get(care_id));this.timers.delete(care_id);}
    if(stood.length)this.note(principal,at,'主人有回应，没有通知紧急联系人');
    if(words?.trim()&&(stood.length||this.db.prepare('SELECT 1 FROM events WHERE principal_id=? AND at_ms>=? AND reached=1').get(principal,at-RECENT_MS))){
      this.db.prepare('UPDATE events SET answered=1 WHERE principal_id=? AND reached=1 AND at_ms>=?').run(principal,at-RECENT_MS);
      this.note(principal,at,`主人：${words.trim()}`);
    }
    return {cancelled:stood.length};
  }
  private arm(care_id:string,due:number):void {
    const timer=setTimeout(()=>{
      this.timers.delete(care_id);
      if(this.db.isOpen&&this.db.prepare("UPDATE escalations SET state='firing' WHERE care_id=? AND state='armed'").run(care_id).changes)
        void this.alert(care_id).catch(failed('CARE_ALERT_FAILED'));
    },Math.max(0,due-this.now()));
    timer.unref?.();this.timers.set(care_id,timer);
  }
  /** No response: each emergency contact gets the same text through the phone executor; with none reachable the owner's phone
   *  is told. The state is final either way: never a second alert. */
  private async alert(care_id:string):Promise<void> {
    const ports=this.ports!,e=this.db.prepare('SELECT principal_id,device_id,at_ms,location FROM escalations WHERE care_id=?').get(care_id) as
      {principal_id:string;device_id:string;at_ms:number;location:string|null};
    const {call,contacts}=await this.owner(e.principal_id),who=call??'机主',position=await ports.locate(e.principal_id,e.device_id,true);
    if(!this.db.isOpen)return;
    // The owner can respond while the bounded one-shot is in flight, before any SMS has started.
    if(this.db.prepare('SELECT 1 FROM meta WHERE key=? AND CAST(value AS INTEGER)>=?').get(`owner-response:${e.principal_id}`,e.at_ms)){
      this.db.prepare("UPDATE escalations SET state='cancelled',outcome='主人有回应' WHERE care_id=?").run(care_id);
      this.note(e.principal_id,this.now(),'主人有回应，没有通知紧急联系人');return;
    }
    const fix=position.current??position.last_known??(e.location?JSON.parse(e.location) as CaptureLocation:undefined);
    const where=locationLine(this.time_zone,fix,position.current!==undefined);
    const text=`【依米紧急提醒】我是${who}的AI助理依米。${who}的手表在${stamp(e.at_ms,this.time_zone)}检测到可能摔倒，已60秒无回应，可能受伤或失去意识。${where}。请尽快联系${who}。`;
    const sent:string[]=[],missed:string[]=[];
    await Promise.all(contacts.map(async c=>{
      if(c.phone)try {await ports.sms({principal_id:e.principal_id,id:digest([care_id,c.phone]),to:c.phone,text});sent.push(c.name);return;} catch(error){failed('CARE_SMS_FAILED')(error);}
      missed.push(c.name);
    }));
    const outcome=sent.length?`已短信通知紧急联系人${sent.join('、')}${missed.length?`（${missed.join('、')}未确认发出）`:''}`:
      missed.length?`未确认给紧急联系人${missed.join('、')}发出短信`:'没有找到紧急联系人，没能通知任何人';
    this.db.prepare("UPDATE escalations SET state='fired',outcome=? WHERE care_id=?").run(outcome,care_id);
    this.note(e.principal_id,this.now(),`摔倒后60秒无回应：${outcome}`);
    if(!sent.length)await this.say(care_id,e.principal_id,e.device_id,`${care_id}:alert`,`${call?`${call}，`:''}你摔倒后1分钟没有回应，${outcome}。你还好吗？`);
  }
  /** Owner display name and emergency contacts come from native memory; contact cards supply missing phone numbers. */
  private async owner(principal:string):Promise<{call?:string;contacts:{name:string;phone?:string}[]}> {
    const entries=await this.ports!.memory().catch(()=>[] as string[]),normal=(n:string)=>n.replace(/[\s-]/gu,'');
    const call=ownerMemoryName(entries);
    const contacts=entries.flatMap(e=>[...e.matchAll(/紧急联系人[:：]\s*([^\n]+)/gu)].map(([,line])=>{
      const number=/\+?\d[\d -]{5,}\d/u.exec(line!)?.[0];
      if(number)return {name:clip(line!.replace(number,''),20)||number,phone:normal(number)};
      const cards=this.ports!.contacts?.named(principal,line!)??[],card=cards.length===1?cards[0]!:undefined;
      const phone=card?.phones.find(p=>/mobile|iphone|手机/iu.test(p.label))??card?.phones[0];
      return {name:card?.name??clip(line!,20),...(phone?{phone:normal(phone.number)}:{})};
    }));
    return {...(call?{call}:{}),contacts:[...new Map(contacts.map(c=>[c.phone??c.name,c])).values()]};
  }
  /** 依米 reaches the owner through the host's outreach rule; the owner's next words answer it. */
  private async say(care_id:string,principal:string,device:string,id:string,text:string):Promise<void> {
    const event=this.db.prepare('SELECT at_ms FROM events WHERE care_id=? AND principal_id=?').get(care_id,principal) as {at_ms:number};
    const row=this.db.prepare('INSERT INTO timeline(principal_id,at_ms,line) VALUES(?,?,?)').run(principal,this.now(),`依米（送达中）：${text}`).lastInsertRowid;
    try {
      const context=await this.ports!.reach(principal,device,id,text,event.at_ms);
      if(!this.db.isOpen)return;
      this.db.prepare('UPDATE events SET reached=1 WHERE care_id=?').run(care_id);
      if(id===`${care_id}:checkin`)this.db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(id,String(this.now()));
      this.db.prepare('UPDATE timeline SET at_ms=?,line=? WHERE rowid=?').run(this.now(),`依米：${context?context.spoken:text}`,row);
    } catch(error) {if(this.db.isOpen)this.db.prepare('UPDATE timeline SET line=? WHERE rowid=?').run(`关心未送达：${text}`,row);failed('CARE_OUTREACH_FAILED')(error);}
  }
  recent(principal:string):string[] {
    return (this.db.prepare("SELECT at_ms,line FROM timeline WHERE principal_id=? AND at_ms>=? AND line!='依米没有打扰' ORDER BY at_ms DESC,rowid DESC")
      .all(principal,this.now()-RECENT_MS) as {at_ms:number;line:string}[]).reverse().map(r=>`${stamp(r.at_ms,this.time_zone)} ${r.line}`);
  }
  private note(principal:string,at:number,line:string):void {
    this.db.prepare('INSERT INTO timeline(principal_id,at_ms,line) VALUES(?,?,?)').run(principal,at,line);
  }
}
