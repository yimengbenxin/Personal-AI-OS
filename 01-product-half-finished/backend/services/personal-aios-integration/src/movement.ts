import {check, ContractError, type CaptureLocation} from './contracts.ts';
import {NAVIGATION_LOCATION_FRESH_MS} from './location.ts';
import {projectNavigation} from './navigation-progress.ts';

export type NavMode='bicycling'|'walking';
export interface NavPlace {name:string;address?:string;lat:number;lng:number}
export type Maneuver='left'|'right'|'slight_left'|'slight_right'|'sharp_left'|'sharp_right'|'straight'|'uturn'|'arrive'|'depart';
export interface NavStep {index:number;maneuver:Maneuver;instruction:string;road?:string;distance_m:number;duration_s:number;polyline:{lat:number;lng:number}[];maneuver_location:{lat:number;lng:number}}
export interface NavRoute {total_m:number;total_s:number;steps:NavStep[]}
export interface NavPlan extends NavRoute {mode:NavMode;destination:NavPlace;alternative?:NavRoute}
export interface Navigation {
  search(query:string,near?:{lat:number;lng:number}):Promise<NavPlace[]>;
  plan(origin:{lat:number;lng:number},destination:NavPlace,mode:NavMode):Promise<NavPlan>;
}
/** Only the provider adapter may attach credential-free diagnostics to a navigation failure. */
export class NavigationProviderError extends ContractError {
  readonly provider_code:string; readonly provider_reason:string; readonly provider_path?:string;
  constructor(code:string,reason:string,path?:string) {
    super('NAVIGATION_PROVIDER_FAILED',502);this.provider_code=code;this.provider_reason=reason;
    if(path)this.provider_path=path;
  }
}
export interface RideMetrics {speed_kmh?:number;speed_sample_at?:string;hr_sample_at?:string;avg_kmh:number;max_kmh:number;distance_m:number;moving_s:number;elapsed_s:number;
  elev_gain_m?:number;hr_bpm?:number;hr_zone?:number;kcal?:number;cadence_rpm?:number;cadence_source?:'sensor'|'pocket_estimate'}
export interface RideSummary {started_at:string;ended_at:string;distance_m:number;moving_s:number;elapsed_s:number;avg_kmh:number;max_kmh:number;
  elev_gain_m?:number;kcal?:number;hr_avg?:number;hr_max?:number}
export interface NavProgress {nav_id:string;revision:number;step_index:number;maneuver:Maneuver;distance_to_maneuver_m:number;road?:string;remaining_m:number;remaining_s:number;route_segment_index:number;segment_fraction:number}
export interface MoveFrame {ride_id?:string;nav_id?:string;seq:number;at:string;position?:{lat:number;lng:number;accuracy_m:number;course_deg?:number;altitude_m?:number;at:string};ride?:RideMetrics;nav?:NavProgress}
export type RideState={ride_id:string;state:'started'|'ended';at:string;started_by:'phone'|'watch'|'glasses'|'voice';summary?:RideSummary};
export type MoveInput=({operation:'ride_state'}&RideState)|({operation:'move_frame'}&MoveFrame)|
  {operation:'nav_state';nav_id:string;state:'arrived'|'cancelled'|'off_route';at:string;position?:{lat:number;lng:number}}|
  {operation:'ride_control';action:'start'|'stop'}|{operation:'nav_control';action:'stop'|'switch'};
type Moving={ride?:Pick<RideState,'ride_id'|'state'>&Partial<RideState>;ride_mode?:boolean;reported?:string;nav?:NavPlan&{nav_id:string;revision:number;selected?:0|1;prompts:Set<string>;off_route_at?:string;progress?:NavProgress;location_at?:string;off_fixes?:number};
  fix?:CaptureLocation;control?:{operation:'ride_control'|'nav_control';run:()=>Promise<unknown>;settled:Promise<void>;expires_at:number;pending:boolean};frame?:MoveFrame&{hr_alert:boolean};hud_at?:number;alert_at?:number;nav_request?:{nav_id:string;current?:()=>boolean;off_route_revision?:number}};

/** The phone owns measurements; this owner holds only the current sessions, one frame and prompt crossings. */
export class Movement {
  private readonly users=new Map<string,Moving>();
  private readonly ports:{navigation?:Navigation;now?:()=>number;ride_hr_alert_bpm?:number;pending_ttl_ms?:number;
    hrProfile?:(principal:string)=>Promise<{max_hr_bpm:number}|undefined>;
    send:(principal:string,terminal:'phone'|'glasses',body:Record<string,unknown>,current?:()=>boolean)=>Promise<void|boolean>;
    event:(principal:string,id:string,at:string,body:Record<string,unknown>,onDurable?:()=>Promise<void>)=>Promise<void>;
    say:(principal:string,text:string,kind:'nav_prompt'|'hr_alert',at:string)=>Promise<void>;
    position:(principal:string)=>Promise<{lat:number;lng:number;location?:CaptureLocation;last_fix_age_ms?:number|null;freshness_bound_ms?:number;error_code?:string}>};
  constructor(ports:Movement['ports']){
    check(ports.pending_ttl_ms===undefined||Number.isSafeInteger(ports.pending_ttl_ms)&&ports.pending_ttl_ms>0,'MOVEMENT_PENDING_TTL_INVALID');
    this.ports=ports;
  }
  private current(principal:string):Moving {
    let state=this.users.get(principal);if(!state){state={};this.users.set(principal,state);}return state;
  }
  status(principal:string) {
    const state=this.current(principal),{ride,frame}=state,nav=state.nav_request?state.nav:undefined;
    return {ride_mode:state.ride_mode??ride?.state==='started',...(ride?{ride:structuredClone(ride)}:{}),...(nav?{navigation:{nav_id:nav.nav_id,revision:nav.revision,mode:nav.mode,destination:nav.destination}}:{}),
      ...(frame?{at:frame.at,...(ride?.state==='started'&&frame.ride?{metrics:structuredClone(frame.ride)}:{}),...(nav&&frame.nav?{progress:structuredClone(frame.nav)}:{})}:{})};
  }
  async controlRide(principal:string,action:'start'|'stop',requested_by:'glasses'|'voice',active?:()=>boolean) {
    const state=this.current(principal);state.ride_mode=action==='start';
    let phone_status='requested';
    try {await this.requestControl(principal,async current=>{
      check(active?.()!==false,'TERMINAL_TOOL_TIMEOUT',504);
      await this.ports.send(principal,'phone',{operation:'ride_control',action,requested_by},()=>active?.()!==false&&current());
      return {status:'requested',action};
    },true,'ride_control');}
    catch(error){if(!(error instanceof ContractError&&error.code==='PHONE_NOT_CONNECTED'))throw error;
      phone_status=error.code;}
    const displayed=await this.showMovement(principal);
    return {status:phone_status==='requested'?'requested':displayed===false?'pending':action==='start'?'glasses_started':'glasses_stopped',action,phone_status,phone_recording:'unconfirmed',glasses_status:displayed===false?'not_connected':'shown'};
  }
  private showMovement(principal:string,fix?:CaptureLocation) {
    const state=this.current(principal),nav=state.nav_request?state.nav:undefined,progress=nav?.progress;
    const now=this.ports.now?.()??Date.now(),frame=state.frame;
    return this.ports.send(principal,'glasses',{operation:'move_hud',kind:state.ride_mode?(nav?'ride_nav':'ride'):'walk_nav',
      at:new Date(now).toISOString(),seq:frame?.seq??0,coordinate_system:'wgs84',
      ...(state.ride_mode&&frame?.ride&&now-Date.parse(frame.at)<=5000?{ride:{...frame.ride,hr_alert:frame.hr_alert}}:{}),
      ...(fix?{position:{lat:fix.latitude,lng:fix.longitude,accuracy_m:fix.accuracy_m,at:fix.observed_at}}:{}),
      ...(progress?{nav:{...progress,maneuver_location:nav!.steps.find(step=>step.index===progress.step_index)!.maneuver_location}}:{})});
  }
  /** Background GPS drives the same route while the phone's foreground movement producer is asleep. */
  async location(principal:string,fix:CaptureLocation,refresh=false) {
    const state=this.current(principal),nav=state.nav_request?state.nav:undefined,now=this.ports.now?.()??Date.now(),age=now-Date.parse(fix.observed_at);
    if(age<0||age>NAVIGATION_LOCATION_FRESH_MS||!state.ride_mode&&!nav)return;
    if(!state.fix||Date.parse(fix.observed_at)>=Date.parse(state.fix.observed_at))state.fix=structuredClone(fix);
    if(!refresh&&state.frame?.nav&&now-Date.parse(state.frame.at)<=5000)return;
    if(nav){
      if(nav.location_at&&(Date.parse(fix.observed_at)<Date.parse(nav.location_at)||!refresh&&fix.observed_at===nav.location_at))return;
      nav.location_at=fix.observed_at;
      const projected=projectNavigation(nav,{lat:fix.latitude,lng:fix.longitude},nav.progress?.step_index);
      nav.progress=projected.progress;
      if(age<=5000&&!refresh){
        nav.off_fixes=projected.distance_from_route_m>40?(nav.off_fixes??0)+1:0;
        if(projected.arrived||nav.off_fixes>=3){
          await this.navState(principal,{operation:'nav_state',nav_id:nav.nav_id,state:projected.arrived?'arrived':'off_route',at:fix.observed_at,
            position:{lat:fix.latitude,lng:fix.longitude}});
        }
      }
    }
    await this.showMovement(principal,fix);
  }
  private async requestControl<T>(principal:string,run:(current:()=>boolean)=>Promise<T>,retain:boolean,operation:'ride_control'|'nav_control'):Promise<T> {
    const state=this.current(principal),previous=state.control,done=Promise.withResolvers<void>(),request:Omit<NonNullable<Moving['control']>,'run'>&{run:()=>Promise<T>}={operation,run:()=>run(()=>state.control===request&&request.expires_at>(this.ports.now?.()??Date.now())),
      settled:done.promise,expires_at:(this.ports.now?.()??Date.now())+(this.ports.pending_ttl_ms??120000),pending:false};
    state.control=request;
    try {
      const result=await request.run();if(state.control===request){
        if(operation==='nav_control'&&state.ride_mode&&previous?.operation==='ride_control'&&previous.pending)state.control=previous;
        else delete state.control;
      }return result;
    }catch(error){
      if(state.control===request){
        if(retain&&error instanceof ContractError&&error.code==='PHONE_NOT_CONNECTED')request.pending=true;
        else delete state.control;
      }
      throw error;
    }finally{done.resolve();}
  }
  async phoneConnected(principal:string):Promise<void> {
    const state=this.current(principal),request=state.control;
    if(!request){const nav=state.nav;if(nav&&state.nav_request)await this.ports.send(principal,'phone',this.routeBody(nav),()=>state.nav===nav&&!!state.nav_request);return;}
    await request.settled;
    if(state.control!==request)return this.phoneConnected(principal);
    if(!request.pending)return;
    request.pending=false;
    try {if(request.expires_at>(this.ports.now?.()??Date.now()))await request.run();}
    catch(error){if(state.control===request&&request.expires_at>(this.ports.now?.()??Date.now()))
      await this.ports.send(principal,'glasses',{operation:'rejected',request_operation:request.operation,control_id:null,event_id:null,processed_event_id:null,
        error_code:error instanceof ContractError?error.code:'MOVEMENT_DELIVERY_FAILED'});}
    finally{if(state.control===request)delete state.control;}
    const nav=state.nav;if(request.operation==='ride_control'&&nav&&state.nav_request)await this.ports.send(principal,'phone',this.routeBody(nav),()=>state.nav===nav&&!!state.nav_request);
  }
  async glassesConnected(principal:string):Promise<void> {
    const state=this.current(principal),nav=state.nav;
    if(nav&&state.nav_request)await this.ports.send(principal,'glasses',this.routeBody(nav),()=>state.nav===nav&&!!state.nav_request);
    await this.showMovement(principal,state.fix);
  }
  private routeBody(nav:NonNullable<Moving['nav']>,show=false) {
    const {nav_id,revision,mode,destination,total_m,total_s,steps}=nav;
    const selected=nav.selected??0,routes=nav.alternative?[nav.alternative]:[];
    const alternatives=routes.map(route=>({total_m:route.total_m,total_s:route.total_s,polyline:route.steps.flatMap(step=>step.polyline)}));
    return {operation:'nav_route',coordinate_system:'wgs84',nav_id,revision,mode,destination:{name:destination.name,lat:destination.lat,lng:destination.lng},total_m,total_s,steps,
      overview:{version:1,selected,alternatives,show}};
  }
  async rideState(principal:string,ride:RideState,onDurable?:()=>Promise<void>) {
    const state=this.current(principal),previous=state.ride,same=previous?.ride_id===ride.ride_id&&previous.state===ride.state;
    if(same&&state.reported===ride.state){await onDurable?.();return;}
    const knownAt=previous?.at??(state.frame?.ride_id===previous?.ride_id?state.frame?.at:undefined);
    const latest=!(previous?.state==='started'&&previous.ride_id!==ride.ride_id&&ride.state==='ended')&&
      !(previous?.ride_id===ride.ride_id&&previous.state==='ended'&&ride.state==='started')&&
      (!knownAt||Date.parse(ride.at)>=Date.parse(knownAt)||previous?.ride_id===ride.ride_id&&(ride.state==='ended'||previous.at===undefined));
    if(latest){if(previous?.ride_id!==ride.ride_id){delete state.alert_at;delete state.frame;}state.ride=structuredClone(ride);delete state.reported;}
    if(latest)state.ride_mode=ride.state==='started';
    const stored=state.ride;
    const report=this.ports.event(principal,`ride:${ride.ride_id}:${ride.state}`,ride.at,{kind:ride.state==='started'?'ride_start':'ride_end',...ride},onDurable);
    await Promise.all([report,...(latest?[this.ports.send(principal,'phone',{operation:'ride_feedback',ride_id:ride.ride_id,at:ride.at,hr_zone:null,text:null,max_hr_bpm:null})]:[]),...(ride.state==='ended'?[this.ports.send(principal,'glasses',{operation:'ride_summary',ride_id:ride.ride_id,...ride.summary!})]:[])]);
    if(latest&&state.ride===stored)state.reported=ride.state;
  }
  async frame(principal:string,frame:MoveFrame) {
    const state=this.current(principal);let now=this.ports.now?.()??Date.now();const age=now-Date.parse(frame.at);
    if(age<0||age>5000||state.frame&&Date.parse(frame.at)<Date.parse(state.frame.at))return;
    if(frame.ride){
      if(state.ride?.ride_id===frame.ride_id&&state.ride?.state==='ended')return;
      if(state.ride?.ride_id!==frame.ride_id){
        if(state.ride?.at&&Date.parse(frame.at)<Date.parse(state.ride.at))return;
        state.ride={ride_id:frame.ride_id!,state:'started'};delete state.alert_at;delete state.reported;
      }
    }
    const staleNav=frame.nav&&(state.nav&&state.nav.nav_id===frame.nav_id&&(frame.nav.revision<state.nav.revision||frame.nav.revision===state.nav.revision&&state.nav_request?.off_route_revision===state.nav.revision)||
      state.nav?.nav_id!==frame.nav_id&&state.frame?.nav_id===frame.nav_id&&state.frame?.nav===undefined);
    const invalidNav=!!frame.nav&&!staleNav&&!(state.nav&&state.nav.nav_id===frame.nav_id&&frame.nav.nav_id===frame.nav_id&&frame.nav.revision===state.nav.revision&&frame.nav.route_segment_index<state.nav.steps.reduce((count,step)=>count+step.polyline.length,0)-1&&
      state.nav.steps.some(step=>step.index===frame.nav!.step_index&&step.maneuver===frame.nav!.maneuver));
    const last=state.frame,route=state.nav;
    if(last&&last.ride_id===frame.ride_id&&last.nav_id===frame.nav_id&&frame.seq<=last.seq)return;
    const copy=structuredClone(frame),profile=copy.ride?.hr_bpm!==undefined?await this.ports.hrProfile?.(principal):undefined;
    now=this.ports.now?.()??Date.now();
    if(now-Date.parse(frame.at)>5000||state.frame&&Date.parse(frame.at)<Date.parse(state.frame.at)||copy.ride&&(state.ride?.ride_id!==frame.ride_id||state.ride?.state!=='started')||
      state.frame&&state.frame.ride_id===frame.ride_id&&state.frame.nav_id===frame.nav_id&&frame.seq<=state.frame.seq)return;
    if(staleNav||copy.nav&&(state.nav&&!state.nav_request||state.nav!==route||state.nav&&state.nav_request?.off_route_revision===state.nav.revision))delete copy.nav;
    const max=Math.round(profile?.max_hr_bpm??this.ports.ride_hr_alert_bpm??175);
    const hr=copy.ride?.hr_bpm,sampleAt=copy.ride?.hr_sample_at,hrAge=now-Date.parse(sampleAt??copy.at),alert=hr!==undefined&&hrAge>=0&&hrAge<=5000&&hr>=max;
    const text=alert?`心率 ${hr} 了，慢一点，喝口水。`:null;
    if(copy.ride&&hr!==undefined)copy.ride.hr_zone=Math.max(1,Math.min(5,Math.floor(hr/max*10)-4));
    state.frame={...copy,hr_alert:alert};if(copy.ride)state.ride_mode=true;
    if(copy.position&&(!state.fix||Date.parse(copy.position.at)>=Date.parse(state.fix.observed_at)))state.fix={datum:'wgs84',latitude:copy.position.lat,longitude:copy.position.lng,accuracy_m:copy.position.accuracy_m,observed_at:copy.position.at};
    if(copy.nav&&!invalidNav)state.nav!.progress=copy.nav;
    const tasks:Promise<unknown>[]=[];
    if(copy.ride)tasks.push(this.ports.send(principal,'phone',{operation:'ride_feedback',ride_id:copy.ride_id,at:copy.at,
      hr_zone:hr===undefined?null:copy.ride.hr_zone!,text,max_hr_bpm:hr===undefined?null:max}));
    const navProgress=copy.nav&&copy.position&&!invalidNav?{...copy.nav,maneuver_location:state.nav!.steps.find(step=>step.index===copy.nav!.step_index)!.maneuver_location}:undefined;
    if((copy.ride||navProgress)&&(state.hud_at===undefined||now-state.hud_at>=1000)){
      state.hud_at=now;tasks.push(this.ports.send(principal,'glasses',{operation:'move_hud',kind:copy.ride?(navProgress?'ride_nav':'ride'):'walk_nav',at:copy.at,seq:copy.seq,coordinate_system:'wgs84',
        ...(copy.position?{position:copy.position}:{}),
        ...(copy.ride?{ride:{...copy.ride,hr_alert:alert}}:{}),...(navProgress?{nav:navProgress}:{})}));
    }
    if(alert&&(state.alert_at===undefined||now-state.alert_at>=180000)){
      state.alert_at=now;
      tasks.push(this.ports.say(principal,text!,'hr_alert',frame.at),this.ports.event(principal,`ride:${frame.ride_id}:hr:${frame.at}`,frame.at,
        {kind:'ride_hr_alert',ride_id:frame.ride_id,hr_bpm:hr,text}));
    }
    if(copy.nav&&!invalidNav){
      const nav=state.nav!,step=nav.steps.find(step=>step.index===copy.nav!.step_index)!;
      for(const distance of [200,50])if(copy.nav.distance_to_maneuver_m<distance&&!nav.prompts.has(`${step.index}:${distance}`)){
        nav.prompts.add(`${step.index}:${distance}`);tasks.push(this.ports.say(principal,step.instruction,'nav_prompt',frame.at));
      }
    }
    const settled=await Promise.allSettled(tasks),failed=settled.filter((r):r is PromiseRejectedResult=>r.status==='rejected');
    if(failed.length===1)throw failed[0]!.reason;
    if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'MOVEMENT_DELIVERY_FAILED');
    check(!invalidNav,'NAVIGATION_PROGRESS_CONFLICT',409);
  }
  async navigate(principal:string,args:{action?:'stop'|'switch';destination?:string;mode?:NavMode;lat?:number;lng?:number},requested_by?:'glasses',current?:()=>boolean):Promise<unknown> {
    check(current?.()!==false,'TERMINAL_TOOL_TIMEOUT',504);
    if(args.action==='stop')return this.stopNavigation(principal);
    if(args.action==='switch')return this.switchNavigation(principal,current);
    if(requested_by==='glasses')return this.requestControl(principal,valid=>this.navigate(principal,structuredClone(args),undefined,()=>valid()&&current?.()!==false),true,'nav_control');
    check(this.ports.navigation,'NAVIGATION_NOT_CONFIGURED',503);
    const state=this.current(principal),request={nav_id:crypto.randomUUID(),...(current?{current}:{})};state.nav_request=request;
    try {
      const origin=await this.ports.position(principal);
      const point={lat:origin.lat,lng:origin.lng};
      const place=args.lat!==undefined?{name:args.destination!,lat:args.lat,lng:args.lng!}:(await this.provider(this.ports.navigation.search(args.destination!,point)))[0];
      check(place,'NAVIGATION_NO_ROUTE',404);
      check(state.nav_request===request&&request.current?.()!==false,'NAVIGATION_SESSION_CHANGED',409);
      const result=await this.plan(principal,point,place,args.mode!,request);
      if(origin.location)await this.location(principal,origin.location,true);
      return {...result,...(origin.location?{origin:{device_location:origin.location,age_ms:origin.last_fix_age_ms,freshness_bound_ms:origin.freshness_bound_ms}}:{})};
    }catch(error){
      if(state.nav_request===request){if(state.nav)state.nav_request={nav_id:state.nav.nav_id};else delete state.nav_request;}
      throw error;
    }
  }
  private provider<T>(work:Promise<T>):Promise<T> {
    return work.catch(error=>{if(error instanceof NavigationProviderError)throw error;const code=(error as {code?:string})?.code;
      throw new ContractError(code==='NAVIGATION_NO_ROUTE'||code==='NAVIGATION_NOT_CONFIGURED'||code==='NAVIGATION_ROUTE_TOO_LONG'?code:'NAVIGATION_PROVIDER_FAILED',code==='NAVIGATION_ROUTE_TOO_LONG'?413:502);});
  }
  private async plan(principal:string,origin:{lat:number;lng:number},destination:NavPlace,mode:NavMode,request:{nav_id:string;current?:()=>boolean},replan?:NonNullable<Moving['nav']>) {
    check(this.ports.navigation,'NAVIGATION_NOT_CONFIGURED',503);
    const state=this.current(principal),nav={mode,destination,total_m:0,total_s:0,steps:[] as NavStep[],
      nav_id:request.nav_id,revision:(replan?.revision??0)+1,prompts:new Set<string>(),
      ...(replan?.off_route_at!==undefined&&replan.nav_id===request.nav_id?{off_route_at:replan.off_route_at}:{})};
    const route=await this.provider(this.ports.navigation.plan(origin,destination,mode));check(route.steps.length>0,'NAVIGATION_NO_ROUTE',404);
    check(state.nav_request===request&&request.current?.()!==false,'NAVIGATION_SESSION_CHANGED',409);Object.assign(nav,route);
    return this.deliverNavigation(principal,nav,request,!replan);
  }
  private async deliverNavigation(principal:string,nav:NonNullable<Moving['nav']>,request:NonNullable<Moving['nav_request']>,show:boolean) {
    const state=this.current(principal);let phone_status='requested';
    const current=()=>{
      if(state.nav_request!==request||request.current?.()===false)return false;state.nav=nav;return true;
    };
    try {await this.ports.send(principal,'phone',this.routeBody(nav,show),current);}
    catch(error){if(!(error instanceof ContractError&&error.code==='PHONE_NOT_CONNECTED'))throw error;
      phone_status=error.code;current();}
    check(state.nav===nav&&state.nav_request===request&&request.current?.()!==false,'NAVIGATION_SESSION_CHANGED',409);
    const displayed=await this.ports.send(principal,'glasses',this.routeBody(nav,show),()=>state.nav===nav&&state.nav_request===request);
    return {nav_id:nav.nav_id,revision:nav.revision,destination:nav.destination.name,mode:nav.mode,distance_m:nav.total_m,eta_s:nav.total_s,
      phone_status,glasses_status:displayed===false?'not_connected':'route_sent'};
  }
  controlNavigation(principal:string,action:'stop'|'switch') {return this.navigate(principal,{action});}
  private async switchNavigation(principal:string,current?:()=>boolean) {
    const state=this.current(principal),previous=state.nav;
    if(!previous||!state.nav_request)return {status:'no_active_navigation'};
    if(!previous.alternative)return {status:'no_alternative',nav_id:previous.nav_id,revision:previous.revision};
    const nav:NonNullable<Moving['nav']>={...previous,...previous.alternative,
      alternative:{total_m:previous.total_m,total_s:previous.total_s,steps:previous.steps},
      selected:previous.selected===1?0:1,revision:previous.revision+1,prompts:new Set<string>()};
    delete nav.progress;delete nav.location_at;delete nav.off_fixes;
    const request={nav_id:nav.nav_id,...(current?{current}:{})};state.nav_request=request;state.nav=nav;
    if(state.control?.operation==='nav_control')delete state.control;
    if(state.frame?.nav_id===nav.nav_id)delete state.frame.nav;
    const result=await this.deliverNavigation(principal,nav,request,true);
    if(state.nav===nav&&state.nav_request===request&&state.fix)await this.location(principal,state.fix,true);
    return {status:'switched',...result};
  }

  async navState(principal:string,body:Extract<MoveInput,{operation:'nav_state'}>,onDurable?:()=>Promise<void>) {
    const applyNavigation=async()=>{
      const state=this.current(principal),nav=state.nav;
      if(body.state!=='off_route'){
        if(nav?.nav_id===body.nav_id)delete state.nav;if(state.frame?.nav_id===body.nav_id)delete state.frame.nav;
        if(state.nav_request?.nav_id===body.nav_id)delete state.nav_request;return;
      }
      if(nav?.nav_id!==body.nav_id)return;
      if(state.nav_request?.nav_id!==body.nav_id)return;
      check(this.ports.navigation,'NAVIGATION_NOT_CONFIGURED',503);
      if(nav.off_route_at!==undefined&&Date.parse(body.at)<=Date.parse(nav.off_route_at))return;nav.off_route_at=body.at;
      const request:NonNullable<Moving['nav_request']>={nav_id:nav.nav_id,off_route_revision:nav.revision};state.nav_request=request;
      const work=[this.ports.say(principal,'走过了，正在重新规划','nav_prompt',body.at),
        Promise.resolve(body.position??this.ports.position(principal)).then(async origin=>{
          check(state.nav===nav&&state.nav_request===request,'NAVIGATION_SESSION_CHANGED',409);
          await this.plan(principal,origin,nav.destination,nav.mode,request,nav);
        }).finally(()=>{delete request.off_route_revision;})];
      const failed=(await Promise.allSettled(work)).filter((r):r is PromiseRejectedResult=>r.status==='rejected');
      if(failed.length===1)throw failed[0]!.reason;if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'MOVEMENT_DELIVERY_FAILED');
    };
    const effects=[this.ports.event(principal,`nav:${body.nav_id}:${body.state}:${body.at}`,body.at,{kind:`nav_${body.state}`,...body},onDurable),applyNavigation()];
    const failed=(await Promise.allSettled(effects)).filter((r):r is PromiseRejectedResult=>r.status==='rejected');
    if(failed.length===1)throw failed[0]!.reason;if(failed.length)throw new AggregateError(failed.map(r=>r.reason),'MOVEMENT_DELIVERY_FAILED');
  }

  async stopNavigation(principal:string) {
    const state=this.current(principal),nav=state.nav;
    if(state.control?.operation==='ride_control'&&state.ride?.state!=='started')state.ride_mode=false;
    delete state.control;delete state.nav_request;
    const nav_id=nav?.nav_id??state.frame?.nav_id;if(!nav_id){await this.showMovement(principal);return {status:'stopped'};}
    if(state.frame?.nav_id===nav_id)delete state.frame.nav;
    if(state.nav===nav)delete state.nav;
    await this.showMovement(principal);
    try {await this.requestControl(principal,current=>this.ports.send(principal,'phone',{operation:'nav_control',nav_id,action:'stop'},current),true,'nav_control');}
    catch(error){if(!(error instanceof ContractError&&error.code==='PHONE_NOT_CONNECTED'))throw error;return {status:'stopped',phone_status:error.code};}
    return {status:'stopped'};
  }
}
