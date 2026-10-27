import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {check} from '../contracts.ts';

/** Existing OpenCV runtime. Only registered slide/pointer pixels leave this geometric adapter. */
export async function meetingContactSheet(frames:Buffer[],slide:Buffer,signal:AbortSignal):Promise<Buffer>{
  check(frames.length>=1&&frames.length<=3&&[slide,...frames].every(image=>image.length>0&&image.length<=3*1024*1024),'MEETING_IMAGE_BUDGET');
  const child=spawn(process.env.PAIOS_VISION_PYTHON??'python3',[fileURLToPath(new URL('./contact_sheet.py',import.meta.url))],
    {signal:AbortSignal.any([signal,AbortSignal.timeout(30000)]),stdio:['pipe','pipe','ignore']});
  const chunks:Buffer[]=[];let bytes=0;
  child.stdout.on('data',chunk=>{bytes+=chunk.length;if(bytes>5*1024*1024)child.kill();else chunks.push(chunk);});child.stdin.on('error',()=>{});
  child.stdin.end(JSON.stringify({slide:slide.toString('base64'),frames:frames.map(frame=>frame.toString('base64'))}));
  await new Promise<void>((resolve,reject)=>{child.once('error',reject);child.once('close',code=>code===0?resolve():reject(Error('MEETING_PROJECTION_UNAVAILABLE')));});
  return Buffer.concat(chunks);
}
