import {watch} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import type {TestContext} from 'node:test';

// Install before spawning. The child publishes by rename, so the event proves a complete PID exists.
export function childPid(t:TestContext,directory:string,name:string){
  const ready=Promise.withResolvers<number>(),path=join(directory,name);
  const watcher=watch(directory,(_event,file)=>{
    if(String(file)!==name)return;
    void readFile(path,'utf8').then(text=>{
      if(!/^[1-9][0-9]*$/u.test(text))throw new Error('child published an invalid PID');
      watcher.close();ready.resolve(Number(text));
    }).catch(ready.reject);
  });
  watcher.on('error',ready.reject);t.after(()=>watcher.close());
  return {ready:ready.promise,source:`const fs=require('node:fs');fs.writeFileSync(${JSON.stringify(path+'.tmp')},String(process.pid));fs.renameSync(${JSON.stringify(path+'.tmp')},${JSON.stringify(path)});`};
}
