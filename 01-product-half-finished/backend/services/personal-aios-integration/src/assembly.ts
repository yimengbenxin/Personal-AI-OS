import { RawArchive } from './archive.ts';
import { RunAdmission, type AdmissionPolicy } from './admission.ts';
import { OutputAuthority, type OutputConfig } from './output.ts';
import { PersonalAIOSRuntime, type FixtureRegisteredDevice, type SourceDeviceAuthority } from './runtime.ts';
import { createPersonalAIOSServer } from './server.ts';
import type { NativeClient } from './hermes-client.ts';
import { PosixStorage, type StoragePort } from './storage.ts';
import type { L3Service } from './memory/l3.ts';
import type { ActionAuthority } from './actions/authority.ts';
import type { MediaService } from './media/service.ts';

export interface PersonalAIOSAssemblyResources {
  time_zone?:string;
  model_settings?:{attach:(runtime:PersonalAIOSRuntime)=>void};
  storage: StoragePort; native: NativeClient; admission: AdmissionPolicy; skill: string;
  max_event_bytes: number; max_read_bytes: number; archive?: RawArchive;
  session_folding?:boolean;
  realtime_busy?:()=>boolean;
  archive_tiering?:{hot_days:number;max_upload_kbps?:number;paused?:boolean};
  sourceAuthority?: SourceDeviceAuthority; devices?: FixtureRegisteredDevice[];
  l3?: L3Service; actions?: ActionAuthority; media?: MediaService;
  quarantine_admission?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['quarantine_admission'];
  voice?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['voice'];
  audio_route?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['audio_route'];
  continuous_context?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['continuous_context'];
  core_profile?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['core_profile'];
  payment?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['payment'];
  payment_ports?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['payment_ports'];
  payment_devices?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['payment_devices'];
  payment_clock_map?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['payment_clock_map'];
  speech_detector?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['speech_detector'];
  voice_model_current?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['voice_model_current'];
  voiceprint?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['voiceprint'];
  owner_override?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['owner_override'];
  capability_grants?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['capability_grants'];
  voice_confirmation?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['voice_confirmation'];
  ambient_journal?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['ambient_journal'];
  visual_memory?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['visual_memory'];
  health?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['health'];
  contacts?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['contacts'];
  locations?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['locations'];
  avatar?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['avatar'];
  navigation?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['navigation'];
  movement?:ConstructorParameters<typeof PersonalAIOSRuntime>[0]['movement'];
  speech?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['speech'];
  call_heard?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['call_heard'];
  care?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['care'];
  care_sms?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['care_sms'];
  staging_outreach?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['staging_outreach'];
  notify?: ConstructorParameters<typeof PersonalAIOSRuntime>[0]['notify'];
  output?: Pick<OutputConfig, 'tts'>;
  http: Parameters<typeof createPersonalAIOSServer>[1];
}
// Single source-owned ING/admission/MEM/OUT assembly. Resource provisioning remains with the calling owner.
export function createPersonalAIOSAssembly(resources: PersonalAIOSAssemblyResources) {
  const admission = new RunAdmission(resources.storage, resources.native, resources.admission);
  const archive=resources.archive??new RawArchive(resources.storage,resources.max_event_bytes);
  archive.setSessionFolding(resources.session_folding??true);
  archive.setHotDays(resources.archive_tiering?.hot_days??2);
  let runtime: PersonalAIOSRuntime;
  const output = new OutputAuthority(resources.storage, {...resources.output,
    resolveReceipt: (ref, context) => runtime.resolveReceipt(ref, context),
    authorizeEvidence: (ref, context) => runtime.authorizeEvidence(ref, context),
    listRunReceipts: context => runtime.runReceipts(context)});
  runtime = new PersonalAIOSRuntime({storage: resources.storage, native: resources.native, admission, output,
    archive,...(resources.time_zone?{time_zone:resources.time_zone}:{}),
    automatic_output:{onError:error=>console.error('AUTOMATIC_OUTPUT_FAILED',error instanceof Error ? error.message : 'unknown')},
    skill: resources.skill, max_read_bytes: resources.max_read_bytes,
    ...(resources.realtime_busy?{realtime_busy:resources.realtime_busy}:{}),
    ...(resources.sourceAuthority ? {sourceAuthority:resources.sourceAuthority} : {}),
    ...(resources.devices ? {devices:resources.devices} : {}),
    ...(resources.l3 ? {l3:resources.l3} : {}), ...(resources.actions ? {actions:resources.actions} : {}),
    ...(resources.quarantine_admission ? {quarantine_admission:resources.quarantine_admission} : {}),
    ...(resources.media ? {media:resources.media} : {}),
    ...(resources.voice ? {voice:resources.voice} : {}),
    ...(resources.audio_route ? {audio_route:resources.audio_route} : {}),
    ...(resources.continuous_context ? {continuous_context:resources.continuous_context} : {}),
    ...(resources.core_profile ? {core_profile:resources.core_profile} : {}),
    ...(resources.payment?{payment:resources.payment}:{}),...(resources.payment_ports?{payment_ports:resources.payment_ports}:{}),...(resources.payment_devices?{payment_devices:resources.payment_devices}:{}),
    ...(resources.payment_clock_map?{payment_clock_map:resources.payment_clock_map}:{}),
    ...(resources.speech_detector?{speech_detector:resources.speech_detector}:{}),
    ...(resources.voice_model_current?{voice_model_current:resources.voice_model_current}:{}),
    ...(resources.voiceprint ? {voiceprint:resources.voiceprint} : {}),
    ...(resources.owner_override ? {owner_override:resources.owner_override} : {}),
    ...(resources.capability_grants?{capability_grants:resources.capability_grants}:{}),
    ...(resources.voice_confirmation ? {voice_confirmation:resources.voice_confirmation} : {}),
    ...(resources.ambient_journal ? {ambient_journal:resources.ambient_journal} : {}),
    ...(resources.visual_memory?{visual_memory:resources.visual_memory}:{}),
    ...(resources.health ? {health:resources.health} : {}),
    ...(resources.contacts ? {contacts:resources.contacts} : {}),
    ...(resources.locations ? {locations:resources.locations} : {}),
    ...(resources.avatar ? {avatar:resources.avatar} : {}),
    ...(resources.navigation?{navigation:resources.navigation}:{}),...(resources.movement?{movement:resources.movement}:{}),
    ...(resources.speech ? {speech:resources.speech} : {}),
    ...(resources.call_heard ? {call_heard:resources.call_heard} : {}),
    ...(resources.care ? {care:resources.care} : {}), ...(resources.care_sms ? {care_sms:resources.care_sms} : {}),
    ...(resources.staging_outreach ? {staging_outreach:resources.staging_outreach} : {}),
    ...(resources.notify ? {notify:resources.notify} : {})});
  resources.model_settings?.attach(runtime);
  const server = createPersonalAIOSServer(runtime, resources.http);
  // Recovery shares the maintenance lifecycle. Listening/health must let Hermes bootstrap first.
  const recover=async()=>{
    await resources.http.capability_ready;
    if(closing)return;
    admission.setNativeReady(false);
    if(!await resources.native.ready(resources.http.max_request_bytes)||closing)return;
    admission.setNativeReady(true);
    const results=await Promise.allSettled([admission.recover(),runtime.capabilityConsent!.recover(),runtime.reconcileActivities()]);
    results.forEach((result,index)=>{if(result.status==='rejected')console.error(
      ['ADMISSION_RECOVERY_FAILED','CAPABILITY_RECOVERY_FAILED','ACTIVITY_RECOVERY_FAILED'][index],result.reason instanceof Error?result.reason.message:'unknown');});
  };
  let tierTimer:ReturnType<typeof setTimeout>|undefined,tierWork=Promise.resolve(),tierRunning=false;
  let capabilityMonitorWork:Promise<void>|undefined;
  let recoveryWork:Promise<void>|undefined;
  const tier=()=>{if(tierRunning||closing)return;tierRunning=true;const started=performance.now();
    tierWork=(async()=>{
      try{
        if(resources.realtime_busy?.()){console.info('L5_TIERING_PAUSED','realtime_busy');return;}
        recoveryWork??=recover().catch(error=>console.error('HERMES_RECOVERY_DEFERRED',error instanceof Error?error.message:'unknown'))
          .finally(()=>{recoveryWork=undefined;});
        await runtime.applyModelSettings();
        await runtime.recoverModelUsage();
        // Package probes share this clock, but cannot hold storage maintenance or overlap each other.
        if(!capabilityMonitorWork)capabilityMonitorWork=runtime.monitorCapabilities()
          .catch(()=>console.error('CAPABILITY_MONITOR_UNAVAILABLE'))
          .finally(()=>{capabilityMonitorWork=undefined;});
        if(resources.storage instanceof PosixStorage)await resources.storage.monitorReserve();
        if(closing)return;
        if(!resources.archive_tiering)await runtime.archiveAlert('L5_TIERING_NOT_CONFIGURED');
        if(resources.archive_tiering||resources.session_folding!==false)await archive.maintenance(resources.archive_tiering?.hot_days??2,Date.now(),
          {...(resources.realtime_busy?{busy:resources.realtime_busy}:{}),
            paused:resources.archive_tiering?.paused??false,
            ...(resources.archive_tiering?.max_upload_kbps!==undefined?{max_upload_kbps:resources.archive_tiering.max_upload_kbps}:{})});
      }catch(error){console.error('L5_TIERING_UNAVAILABLE',error);}
    })().catch(error=>console.error('L5_OWNER_ALERT_UNDELIVERED',error)).finally(()=>{
      tierRunning=false;
      if(!closing){tierTimer=setTimeout(tier,Math.max(0,60000-(performance.now()-started)));tierTimer.unref();}
    });};
  let closing: Promise<void> | undefined;
  const close = () => closing ??= Promise.resolve().then(async () => {
    clearTimeout(tierTimer);
    // Register both owners before invocation; a rejected or throwing sibling cannot skip the other join.
    const settled = await Promise.allSettled([
      Promise.resolve().then(() => archive.close()),
      Promise.resolve().then(() => server.closeAndDrain()),
      Promise.resolve().then(() => runtime.close())
    ]);
    await tierWork;
    await recoveryWork;
    await capabilityMonitorWork;
    const errors = settled.filter(result => result.status === 'rejected').map(result => result.reason);
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, 'ASSEMBLY_CLOSE_FAILED');
  });
  server.once('listening', () => {
    admission.setNativeReady(false);
    resources.http.capability_ready=runtime.wireCapabilities();
    void resources.http.capability_ready.catch(error=>console.error('CAPABILITY_WIRING_FAILED',error instanceof Error?error.message:'unknown'));
    void archive.recover().catch(error=>console.error('L5_INGRESS_RECOVERY_UNAVAILABLE',error instanceof Error?error.message:'unknown'));
    tier();
  });
  return Object.freeze({runtime, server, close});
}
