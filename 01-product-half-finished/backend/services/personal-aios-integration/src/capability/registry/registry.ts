import {mkdir, mkdtemp, readFile, writeFile, rename, readdir, lstat, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {inspectPackage, packageDigest, verifyEvidence} from './checks.ts';
import type {PackageContext, PackageVersion, PackageFiles, EnabledPackageAuthority,
  RegistrationRunner, PackageLedger, DiscoverySources, ContractEvidence} from './interfaces.ts';

interface Candidate {principal: string; version: PackageVersion; expected: string | null; evidence: ContractEvidence; consumed: boolean; expires_at?:number}
interface Release {id: string; name: string; before: PackageVersion | null; after: PackageVersion; principal?:string;
  reverted: boolean; reason: string; state: 'prepared' | 'applied' | 'aborted'; rollback_call_ids?: string[]}
const key = (value: string) => createHash('sha256').update(value).digest('hex');
export interface RegistryPolicy {candidate_ttl_ms?:number;max_bytes?:number;now?:()=>number;reserve?:(bytes:number)=>Promise<void>}
export async function readPackage(root: string): Promise<PackageFiles> {
  const files: PackageFiles = {};
  async function visit(relative: string) {
    for (const entry of await readdir(join(root, relative))) {
      const path = join(relative, entry), info = await lstat(join(root, path));
      if (info.isDirectory()) await visit(path);
      else if (info.isFile()) files[path] = await readFile(join(root, path), 'utf8');
      else throw new Error('package_special_file');
    }
  }
  await visit('');
  return files;
}

/** Registration evidence and version history only. Enabled packages stay with P1. */
export class CapabilityRegistry {
  private tail: Promise<unknown> = Promise.resolve();
  private root: string;
  private authority: EnabledPackageAuthority;
  private runner: RegistrationRunner;
  private ledger: PackageLedger;
  private sources: DiscoverySources;
  private policy:Required<RegistryPolicy>;
  constructor(root: string, authority: EnabledPackageAuthority,
    runner: RegistrationRunner, ledger: PackageLedger, sources: DiscoverySources, policy:RegistryPolicy={}) {
    this.root = root; this.authority = authority; this.runner = runner; this.ledger = ledger; this.sources = sources;
    this.policy={candidate_ttl_ms:86400000,max_bytes:64*1024*1024,now:Date.now,reserve:async()=>{},...policy};
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.tail.then(fn, fn); this.tail = next.catch(() => {}); return next;
  }
  private guard(context: PackageContext) {
    if (!['owner', 'build'].includes(context.scope) || !context.principal_id) throw new Error('package_scope_denied');
  }
  private async history(context: PackageContext): Promise<Release[]> {
    try {return JSON.parse(await readFile(join(this.root,key(context.principal_id)+'.json'),'utf8'));}
    catch (error: any) {if (error.code === 'ENOENT') return []; throw error;}
  }
  private saveHistory(context: PackageContext, history: Release[]) {
    return this.save(join(this.root,key(context.principal_id)+'.json'),history.map(row=>({...row,principal:context.principal_id})));
  }
  private async capacity(bytes:number){
    const size=async(path:string):Promise<number>=>{
      const stat=await lstat(path);
      if(!stat.isDirectory())return stat.size;
      let total=0;for(const name of await readdir(path))total+=await size(join(path,name));return total;
    };
    if(await size(this.root)+bytes>this.policy.max_bytes)throw new Error('package_storage_quota');
    await this.policy.reserve(bytes);
  }
  private async save(path:string,value:unknown){
    const body=JSON.stringify(value);await this.capacity(Buffer.byteLength(body));
    try{await writeFile(path+'.tmp',body,{mode:0o600});await rename(path+'.tmp',path);}
    finally{await rm(path+'.tmp',{force:true});}
  }
  private async expiry(path:string,candidate:Candidate){
    return candidate.expires_at??(await lstat(path)).mtimeMs+this.policy.candidate_ttl_ms;
  }
  private async candidate(context:PackageContext,id:string):Promise<Candidate>{
    if(!/^[a-f0-9]{64}$/u.test(id))throw new Error('candidate_invalid');
    const path=join(this.root,id+'.candidate.json'),candidate:Candidate=JSON.parse(await readFile(path,'utf8'));
    if(candidate.principal!==context.principal_id)throw new Error('candidate_principal_mismatch');
    if(await this.expiry(path,candidate)<=this.policy.now())throw new Error('candidate_expired');
    return candidate;
  }
  /** Reclaim only unreferenced storage; enabled selection remains the single authority for recovery points. */
  recover():Promise<void>{return this.serial(()=>this.prune());}
  private async prune(){
    await mkdir(this.root,{recursive:true,mode:0o700});
    const names=await readdir(this.root),keep=new Set<string>(),principals=new Map<string,string>();
    const histories=new Map<string,Release[]>(),expired:string[]=[];
    for(const name of names.filter(name=>name.endsWith('.candidate.json'))){
      const path=join(this.root,name),candidate:Candidate=JSON.parse(await readFile(path,'utf8'));
      principals.set(key(candidate.principal),candidate.principal);
      if(await this.expiry(path,candidate)<=this.policy.now())expired.push(path);
      else if(!candidate.consumed)keep.add(candidate.version.root);
    }
    for(const name of names.filter(name=>/^[a-f0-9]{64}\.json$/u.test(name))){
      const saved=JSON.parse(await readFile(join(this.root,name),'utf8')),id=name.slice(0,-5);
      histories.set(id,saved);
      if(saved[0]?.principal)principals.set(id,saved[0].principal);
    }
    const pin=(version:PackageVersion|null)=>{if(version)keep.add(version.root);};
    for(const [id,history]of histories){
      // Legacy histories get their principal from the existing candidate, before its expiry is reclaimed.
      if(!principals.has(id)){for(const row of history){pin(row.before);pin(row.after);}continue;}
      for(const row of history)if(row.state==='prepared'){pin(row.before);pin(row.after);}
    }
    for(const [id,principal]of principals){
      for(const current of await this.authority.enabled(principal)){
        pin(current);
        const previous=[...(histories.get(id)??[])].reverse().find(row=>row.name===current.name&&
          (row.state==='applied'||row.state==='prepared'&&row.after.digest===current.digest)&&
          [row.before?.digest,row.after.digest].includes(current.digest));
        if(previous){pin(previous.before);pin(previous.after);}
      }
    }
    const versions=join(this.root,'versions');
    let owners:string[];
    try{owners=await readdir(versions);}catch(error:any){if(error.code!=='ENOENT')throw error;owners=[];}
    for(const principal of owners){
      const owner=join(versions,principal);
      for(const name of await readdir(owner)){
        const directory=join(owner,name);
        for(const digest of await readdir(directory))if(!keep.has(join(directory,digest)))await rm(join(directory,digest),{recursive:true});
        if(!(await readdir(directory)).length)await rm(directory,{recursive:true});
      }
      if(!(await readdir(owner)).length)await rm(owner,{recursive:true});
    }
    await rm(join(this.root,'staging'),{recursive:true,force:true});
    for(const name of names.filter(name=>name.endsWith('.tmp')))await rm(join(this.root,name),{force:true});
    for(const path of expired)await rm(path);
  }
  async find(context: PackageContext, query: string) {
    this.guard(context);
    const terms = query.toLocaleLowerCase().match(/[a-z0-9_-]+|\p{Script=Han}+/gu) ?? [];
    const installed = (await this.authority.installed(context.principal_id)).map(version => ({version,
      score: terms.filter(term => JSON.stringify(version.manifest).toLocaleLowerCase().includes(term)).length}))
      .filter(row => row.score > 0).sort((a, b) => b.score - a.score).map(row => row.version);
    const results: Array<{source: string; matches?: unknown; error?: string}> = [{source: 'installed', matches: installed}];
    for (const [source, search] of [['hermes_hub', this.sources.hub], ['official_mcp', this.sources.mcp]] as const) {
      try {results.push({source, matches: await search(query)});}
      catch {results.push({source, error: 'discovery_unavailable'});}
    }
    return {results};
  }
  async check(context: PackageContext, files: PackageFiles) {
    this.guard(context);
    return this.serial(async () => {
      const {manifest, digest} = inspectPackage(files);
      await this.prune();
      await this.capacity(Object.values(files).reduce((sum,text)=>sum+Buffer.byteLength(text),0));
      const directory = join(this.root, 'versions', key(context.principal_id), manifest.name, digest);
      await mkdir(join(this.root,'staging'),{recursive:true});
      const staged=await mkdtemp(join(this.root,'staging','check-'));
      let promoted=false,committed=false;
      try{
        for (const [path, content] of Object.entries(files)) {
          const target = join(staged, path);
          await mkdir(join(target, '..'), {recursive: true});
          await writeFile(target, content, {mode: 0o600});
        }
        const evidence = await this.runner.check(staged);
        verifyEvidence(manifest.extensions['ai.yimi.capability'], evidence);
        if (packageDigest(await readPackage(staged)) !== digest) throw new Error('checked_package_changed');
        const current = (await this.authority.enabled(context.principal_id)).find(row => row.name === manifest.name);
        if (current && current.manifest.extensions?.['ai.yimi.capability'].maintainer !== 'yimi') throw new Error('lead_package_protected');
        if (current && current.version === manifest.version && current.digest !== digest) throw new Error('version_reused');
        if ((await this.history(context)).some(row => row.name === manifest.name && row.after.version === manifest.version && row.after.digest !== digest)) {
          throw new Error('version_reused');
        }
        const version: PackageVersion = {name: manifest.name, version: manifest.version, digest, root: directory, manifest};
        const candidate: Candidate = {principal: context.principal_id, version, expected: current?.digest ?? null, evidence,
          consumed: current?.digest === digest,expires_at:this.policy.now()+this.policy.candidate_ttl_ms};
        const id = key(context.principal_id + ':' + digest);
        await mkdir(join(directory,'..'),{recursive:true});
        try{await lstat(directory);
          if(packageDigest(await readPackage(directory))!==digest)throw new Error('checked_package_changed');
        }catch(error:any){if(error.code!=='ENOENT')throw error;await rename(staged,directory);promoted=true;}
        await this.save(join(this.root, id + '.candidate.json'), candidate);committed=true;
        return {success: true, candidate_id: id, digest, evidence};
      }finally{
        await rm(staged,{recursive:true,force:true});
        if(promoted&&!committed){
          await rm(directory,{recursive:true,force:true});
          for(const parent of [join(directory,'..'),join(directory,'../..')])if(!(await readdir(parent)).length)await rm(parent,{recursive:true});
        }
      }
    });
  }
  async publish(context: PackageContext, id: string) {
    this.guard(context);
    return this.serial(async () => {
      const candidate=await this.candidate(context,id);
      const {version} = candidate, {digest, cap} = inspectPackage(await readPackage(version.root));
      if (digest !== version.digest) throw new Error('checked_package_changed');
      verifyEvidence(cap, candidate.evidence);
      const current = (await this.authority.enabled(context.principal_id)).find(row => row.name === version.name) ?? null;
      if (current?.digest === digest) return {success: true, version, changed: false};
      if ((current?.digest ?? null) !== candidate.expected) throw new Error('enabled_package_changed');
      const history = await this.history(context);
      const event: Release = {id: randomUUID(), name: version.name, before: current, after: version, reverted: false, reason: 'publish', state: 'prepared'};
      history.push(event); await this.saveHistory(context, history);
      try {
        await this.authority.replace(context, {name: version.name, expected: candidate.expected, next: version});
      } catch (error) {
        const live = (await this.authority.enabled(context.principal_id)).find(row => row.name === version.name);
        event.state = live?.digest === digest ? 'applied' : 'aborted';
        await this.saveHistory(context, history);
        throw error;
      }
      event.state = 'applied'; await this.saveHistory(context, history);
      candidate.consumed = true; await this.save(join(this.root, id + '.candidate.json'), candidate);
      await this.prune();
      return {success: true, version, changed: true, release_id: event.id};
    });
  }
  async checked(context: PackageContext, id: string) {
    this.guard(context);
    const candidate=await this.candidate(context,id);
    if (packageDigest(await readPackage(candidate.version.root)) !== candidate.version.digest) throw new Error('checked_package_changed');
    return {success: true, candidate_id: id, evidence: candidate.evidence};
  }
  async rollback(context: PackageContext, name = '', reason = 'owner_request', expectedDigest?: string) {
    this.guard(context);
    return this.serial(async () => {
      const history = await this.history(context), enabled = await this.authority.enabled(context.principal_id);
      const callKey = context.tool_call_id ? context.run_id + ':' + context.tool_call_id : undefined;
      const prior = !expectedDigest && callKey ? history.find(row => row.rollback_call_ids?.includes(callKey)) : undefined;
      const release = prior ?? [...history].reverse().find(row => !row.reverted && row.state !== 'aborted' && (!name || row.name === name) &&
        (!expectedDigest || row.after.digest === expectedDigest) &&
        enabled.some(version => version.name === row.name && version.digest === row.after.digest));
      if (!release) throw new Error('no_package_release_to_rollback');
      const outcome = () => ({success: true, name: release.name, restored: release.before, reason: release.reason,
        outcome:release.before?'restored_previous_version':'removed_package'});
      if (prior?.reverted) return outcome();
      const live = enabled.find(version => version.name === release.name)?.digest ?? null;
      if (prior && live === (release.before?.digest ?? null)) {
        release.reverted = true; await this.saveHistory(context, history); return outcome();
      }
      if (release.before && packageDigest(await readPackage(release.before.root)) !== release.before.digest) throw new Error('rollback_package_changed');
      if (callKey && !expectedDigest && !prior) (release.rollback_call_ids ??= []).push(callKey);
      release.reason = reason; await this.saveHistory(context, history);
      await this.authority.replace(context, {name: release.name, expected: release.after.digest, next: release.before});
      release.state = 'applied'; release.reverted = true; release.reason = reason;
      await this.saveHistory(context, history);
      return outcome();
    });
  }
  async status(context: PackageContext, name = '', includeFiles = false) {
    this.guard(context);
    const enabled = (await this.authority.enabled(context.principal_id)).filter(row => !name || row.name === name);
    return {enabled, ...(includeFiles && name ? {files: enabled[0] ? await readPackage(enabled[0].root) : {}} : {}),
      releases: (await this.history(context)).filter(row => !name || row.name === name)};
  }
  async monitor(context: PackageContext, name: string) {
    this.guard(context);
    const {enabled, releases} = await this.status(context, name), current = enabled[0];
    if (!current) throw new Error('package_not_enabled');
    const release = [...releases].reverse().find(row => !row.reverted && row.after.digest === current.digest);
    // A transport failure is unavailable, not evidence that this package version is bad.
    let health: boolean | null = null;
    try {health = await this.runner.health(current);}
    catch {console.warn('CAPABILITY_HEALTH_UNAVAILABLE', name);}
    const now = await this.ledger.outcomes(context.principal_id, name, current.digest);
    const before = release?.before ? await this.ledger.outcomes(context.principal_id, name, release.before.digest) : null;
    // Wilson 95% intervals separate sparse/noisy samples from a clear regression.
    const interval = (n: number, bad: number) => {
      const z = 1.96, p = bad / n, d = 1 + z * z / n;
      const midpoint = (p + z * z / (2 * n)) / d;
      const half = z * Math.sqrt((p * (1 - p) + z * z / (4 * n)) / n) / d;
      return [midpoint - half, midpoint + half];
    };
    const regressed = before && before.total >= 20 && now.total >= 20 &&
      interval(now.total, now.failed + now.unknown)[0]! > interval(before.total, before.failed + before.unknown)[1]!;
    const rollback = health === false || regressed ? await this.rollback(context, name, health === false ? 'health_failed' : 'outcome_regression', current.digest) : null;
    return {health, current: now, previous: before, rollback};
  }
}
