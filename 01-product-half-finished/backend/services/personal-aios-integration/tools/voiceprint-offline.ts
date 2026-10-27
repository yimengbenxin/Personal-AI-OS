import {readFile,writeFile,realpath} from 'node:fs/promises';
import {dirname,resolve,relative,isAbsolute,join,basename} from 'node:path';
import {check,ContractError,digest} from '../src/contracts.ts';
import {PosixStorage} from '../src/storage.ts';
import {isSealedRegistry,loadRegistryCipher} from '../src/voiceprint/cipher.ts';
import {migrateRegistry,voiceprintPolicy,type RegistryDoc,type VoiceprintPolicyOptions} from '../src/voiceprint/registry.ts';
import {evaluateAdaptiveRegistry} from './voiceprint-adaptive-replay.ts';
import {compareSpeakerModels} from './voiceprint-model-comparison.ts';
import {pinnedModels} from './voiceprint-offline-models.ts';

const inside=(root:string,path:string)=>{const r=relative(root,path);return r===''||r!=='..'&&!r.startsWith('../')&&!isAbsolute(r);};
function markdown(result:Awaited<ReturnType<typeof evaluateAdaptiveRegistry>>|Awaited<ReturnType<typeof compareSpeakerModels>>):string {
  if(result.schema==='voiceprint-adaptive-replay/v1'){
    const r=result as Awaited<ReturnType<typeof evaluateAdaptiveRegistry>>;
    return ['# 声纹通道线离线回放\n',`Gate: ${r.gate}；历史投影新增拒绝 ${r.added_false_rejects}；当前线/投影线留一新增拒绝 ${r.current_line_added_false_rejects}/${r.projected_line_added_false_rejects}；计分样本 ${r.scored_samples}。\n`,
      '| 通道 | 确认样本 | 当前/投影线 | 固定 0.65 拒绝 | 新规则拒绝 | 新增拒绝 |',
      '|---|---:|---:|---:|---:|---:|',...Object.entries(r.channels).map(([c,s])=>
        `| ${c} | ${s!.confirmed_samples} | ${s!.current_threshold} / ${s!.final_threshold} | ${s!.baseline_rejected} | ${s!.candidate_rejected} | ${s!.added_false_rejects} |`),
      '\n仅回放保留的确认样本；缺少轮换、替换及历史水位记录，不构成独立真人召回证据。匿名簇不是已标注冒认者。',''].join('\n');
  }
  const r=result as Awaited<ReturnType<typeof compareSpeakerModels>>;
  return ['# 同数据声纹模型对比\n',`证据：${r.evidence}；测试窗 ${r.sample_counts.windows}。当前生产模型未改。\n`,
    ...r.models.map(m=>`${m.id}: ${m.status}${Object.keys(m.errors).length?' ('+Object.keys(m.errors).join(', ')+')':''}。`),'',
    '| 模型 | 通道 | 通道线 | 召回 / 误接 | 0.65 召回 / 误接 | 每窗 mean / p95 ms |','|---|---|---:|---|---|---|',
    ...r.models.flatMap(m=>Object.entries(m.channels).map(([c,s])=>`| ${m.id} | ${c} | ${s.verified_line} | ${s.at_channel_line.recall} / ${s.at_channel_line.false_accept_rate} | ${s.at_065.recall} / ${s.at_065.false_accept_rate} | ${s.per_window_ms.mean} / ${s.per_window_ms.p95} |`)),
    '\n同一数值运行点只供测量，候选模型尚未校准；耗时为单线程、batch=1 的 embedding 与余弦计算，不含读盘、模型加载或参考构建。合成证据不能说明真人准确率。',''].join('\n');
}
export async function main(argv:string[]):Promise<void> {
  try{
    const args=new Map<string,string>();check(argv.length%2===0,'EVALUATION_ARGUMENTS_INVALID');
    for(let i=0;i<argv.length;i+=2){check(['--mode','--registry-store','--registry-file','--config','--key-file','--models-dir','--windows','--impostors','--output-prefix'].includes(argv[i]!)&&
      !args.has(argv[i]!)&&argv[i+1]!==undefined,'EVALUATION_ARGUMENTS_INVALID');args.set(argv[i]!,argv[i+1]!);}
    const mode=args.get('--mode')??'adaptive';
    check(['adaptive','compare'].includes(mode)&&args.has('--registry-store')!==args.has('--registry-file')&&args.has('--output-prefix')&&
      (mode==='compare'?args.has('--models-dir')&&args.has('--windows')&&!args.has('--impostors'):!args.has('--models-dir')&&!args.has('--windows')),'EVALUATION_ARGUMENTS_INVALID');
    const source=await realpath(args.get('--registry-store')??args.get('--registry-file')!),requested=resolve(args.get('--output-prefix')!);
    const outputRoot=await realpath(dirname(requested)),prefix=join(outputRoot,basename(requested));
    check(!inside(source,outputRoot)&&prefix+'.json'!==source&&prefix+'.md'!==source,'OFFLINE_OUTPUT_OVERLAPS_INPUT');
    const config=args.has('--config')?JSON.parse(await readFile(args.get('--config')!,'utf8')).voiceprint:undefined;
    const policy:VoiceprintPolicyOptions={...(config?.thresholds?{thresholds:config.thresholds}:{}),
      ...(config?.adaptive_verified?{adaptive_verified:config.adaptive_verified}:{})};
    let bytes:Uint8Array;
    if(args.has('--registry-store')){
      const store=new PosixStorage(source,{read_only:true});
      try{bytes=await store.read('voiceprints',digest('paios.voiceprint.registry.v1'));}finally{await store.close();}
    }else bytes=await readFile(source);
    if(isSealedRegistry(bytes)){
      const key=args.get('--key-file')??config?.encryption_key_file;check(key,'VOICEPRINT_REGISTRY_KEY_REQUIRED');
      bytes=(await loadRegistryCipher(key)).open(bytes);
    }
    const registry=migrateRegistry(JSON.parse(Buffer.from(bytes).toString('utf8'))) as RegistryDoc;
    const impostors=args.has('--impostors')?JSON.parse(await readFile(args.get('--impostors')!,'utf8')):undefined;
    check(impostors===undefined||impostors?.schema==='voiceprint-labelled-impostors/v1'&&Array.isArray(impostors.samples),'OFFLINE_IMPOSTOR_LABEL_INVALID');
    const replay=await evaluateAdaptiveRegistry(registry,{policy,impostors:impostors?.samples});
    const result=mode==='adaptive'?replay:await compareSpeakerModels(JSON.parse(await readFile(args.get('--windows')!,'utf8')),
      {base:dirname(resolve(args.get('--windows')!)),directory:args.get('--models-dir')!,models:await pinnedModels(args.get('--models-dir')!),registry,policy:voiceprintPolicy(policy)});
    // Output is one aggregate pair outside the input store. No recording, embedding, transcript or window id is emitted.
    await writeFile(prefix+'.json',JSON.stringify(result,null,2)+'\n',{flag:'wx',mode:0o600});
    await writeFile(prefix+'.md',markdown(result),{flag:'wx',mode:0o600});
    if(mode==='adaptive'&&replay.gate!=='pass')process.exitCode=1;
    if('complete' in result&&!result.complete)process.exitCode=1;
    process.stdout.write(JSON.stringify({mode,...(mode==='adaptive'?{gate:replay.gate,added_false_rejects:replay.added_false_rejects}:{}),written:2})+'\n');
  }catch(error){throw error instanceof ContractError?error:new ContractError('OFFLINE_EVALUATION_FAILED',422);}
}
if(import.meta.main)await main(process.argv.slice(2)).catch(e=>{console.error(e.message);process.exitCode=2;});
