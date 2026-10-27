import {DatabaseSync} from 'node:sqlite';
import {chmodSync,closeSync,existsSync,lstatSync,mkdirSync,openSync,copyFileSync,mkdtempSync,rmSync} from 'node:fs';
import {isAbsolute,join,dirname,basename} from 'node:path';
import {tmpdir} from 'node:os';
import {check} from './contracts.ts';

/** WAL lock upgrades can return BUSY without invoking SQLite's busy handler. Startup only. */
export function configureSqlite(db:DatabaseSync):void {
  const deadline=performance.now()+5000,pause=new Int32Array(new SharedArrayBuffer(4));
  const budget=()=>db.exec(`PRAGMA busy_timeout=${Math.max(0,Math.floor(deadline-performance.now()))};`);
  for(;;){
    try{
      budget();
      if(db.prepare('PRAGMA journal_mode').get()!.journal_mode!=='wal'){
        budget();db.exec('PRAGMA journal_mode=WAL;');
      }
      budget();
      db.exec('PRAGMA synchronous=FULL;PRAGMA busy_timeout=5000;');
      return;
    }catch(error){
      const code=(error as {errcode?:number}).errcode,remaining=deadline-performance.now();
      if(code===undefined||(code&0xff)!==5||remaining<=0)throw error;
      Atomics.wait(pause,0,0,Math.min(10,remaining));
    }
  }
}

/** The owner's private SQLite stores on the Mac (health, contacts): `<storage_root>/<name>/<file>`, a 0700 directory and a
 *  0600 file owned by this user, never a symlink; WAL with synchronous FULL. The DDL runs in one transaction and the
 *  stored schema tag must match. The integration's process lock makes this process the only writer.
 *  (The ambient journal predates this helper and opens itself the same way.) */
export function openOwnerDatabase(directory:string,file:string,ddl:string,schema:string,code:string,extension?:string,previousSchemas:readonly string[]=[]):DatabaseSync {
  check(/^[a-z][a-z0-9-]*\.sqlite3?$/u.test(file)&&isAbsolute(directory),`${code}_PATH_UNSAFE`,500);
  const ownerOnly=(path:string,dir:boolean)=>{
    const stat=lstatSync(path);
    check(!stat.isSymbolicLink()&&(dir?stat.isDirectory():stat.isFile())&&stat.uid===process.getuid?.(),`${code}_PATH_UNSAFE`,500);
    if((stat.mode&0o077)!==0)chmodSync(path,dir?0o700:0o600);
  };
  mkdirSync(directory,{recursive:true,mode:0o700});ownerOnly(directory,true);
  const path=join(directory,file);
  if(!existsSync(path))closeSync(openSync(path,'wx',0o600));
  ownerOnly(path,false);
  for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix))ownerOnly(path+suffix,false);
  const db=new DatabaseSync(path,{allowExtension:extension!==undefined});
  try {
    if(extension){db.loadExtension(extension);db.enableLoadExtension(false);}
    configureSqlite(db);db.exec('PRAGMA foreign_keys=ON;');
    for(const suffix of ['-wal','-shm'])if(existsSync(path+suffix))ownerOnly(path+suffix,false);
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='meta'").get()){
      const tag=db.prepare("SELECT value FROM meta WHERE key='schema'").get() as {value:string}|undefined;
      check(tag?.value===schema||previousSchemas.includes(tag?.value??''),`${code}_SCHEMA_UNSUPPORTED`,503);
    }
    db.exec(`BEGIN IMMEDIATE;${ddl}`);
    db.prepare('INSERT INTO meta(key,value) VALUES(\'schema\',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(schema);
    db.exec('COMMIT');
    check((db.prepare('SELECT value FROM meta WHERE key=\'schema\'').get() as {value:string}).value===schema,`${code}_SCHEMA_UNSUPPORTED`,503);
  } catch(error) {if(db.isTransaction)db.exec('ROLLBACK');db.close();throw error;}
  return db;
}
/** One IMMEDIATE transaction: all of `work` or none of it. */
export function inTransaction<T>(db:DatabaseSync,work:()=>T):T {
  db.exec('BEGIN IMMEDIATE');
  try {const value=work();db.exec('COMMIT');return value;}
  catch(error){
    // FULL can roll back the transaction itself. Cleanup must not replace its capacity error.
    if(db.isTransaction)try{db.exec('ROLLBACK');}catch(rollbackError){
      const failures=[error,rollbackError];
      try{db.close();}catch(closeError){failures.push(closeError);}
      throw new AggregateError(failures,'OWNER_DATABASE_ROLLBACK_FAILED',{cause:error});
    }
    throw error;
  }
}

export interface ResetCategory {name:string;delete_count:number;keep_count:number;delete_bytes:number;keep_bytes:number;unresolved_sources?:number;crossing_sources?:number}
/** Preview SQLite on an offline byte copy: readOnly connections can create source WAL/SHM files. */
export function openReadOnlySnapshot(path:string,allowExtension=false):{db:DatabaseSync;close:()=>void} {
  const temporary=mkdtempSync(join(tmpdir(),'paios-reset-preview-')),target=join(temporary,basename(path));
  try {
    const stat=lstatSync(path),directory=lstatSync(dirname(path));check(stat.isFile()&&!stat.isSymbolicLink()&&directory.isDirectory()&&!directory.isSymbolicLink(),'RESET_DATABASE_PATH_UNSAFE');
    copyFileSync(path,target);if(existsSync(path+'-wal')){const wal=lstatSync(path+'-wal');check(wal.isFile()&&!wal.isSymbolicLink(),'RESET_DATABASE_PATH_UNSAFE');copyFileSync(path+'-wal',target+'-wal');}
    const db=new DatabaseSync(target,{readOnly:true,allowExtension});return {db,close:()=>{try{db.close();}finally{rmSync(temporary,{recursive:true,force:true});}}};
  } catch(error){rmSync(temporary,{recursive:true,force:true});throw error;}
}
/** Offline reset opens existing stores only. Preview never runs DDL or opens a write transaction. */
export function resetOwnerDatabase(path:string,schemas:readonly string[],apply:boolean,work:(db:DatabaseSync)=>ResetCategory):ResetCategory|undefined {
  if(!existsSync(path))return;
  const stat=lstatSync(path),directory=lstatSync(dirname(path));check(stat.isFile()&&!stat.isSymbolicLink()&&directory.isDirectory()&&!directory.isSymbolicLink(),'RESET_DATABASE_PATH_UNSAFE');
  const snapshot=apply?undefined:openReadOnlySnapshot(path);
  const db=snapshot?.db??new DatabaseSync(path);
  try {
    const schema=db.prepare("SELECT value FROM meta WHERE key='schema'").get() as {value:string}|undefined;
    check(schema&&schemas.includes(schema.value),'RESET_DATABASE_SCHEMA_UNSUPPORTED');
    if(!apply)return work(db);
    db.exec('PRAGMA foreign_keys=ON;PRAGMA secure_delete=ON;');
    const result=inTransaction(db,()=>work(db));
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');return result;
  } finally {if(snapshot)snapshot.close();else db.close();}
}
export function resetRowCounts(name:string,rows:Record<string,unknown>[],selected:(row:Record<string,unknown>)=>boolean):ResetCategory {
  const result:ResetCategory={name,delete_count:0,keep_count:0,delete_bytes:0,keep_bytes:0};
  for(const row of rows){const bytes=Buffer.byteLength(JSON.stringify(row));
    if(selected(row)){result.delete_count++;result.delete_bytes+=bytes;}else{result.keep_count++;result.keep_bytes+=bytes;}}
  return result;
}
