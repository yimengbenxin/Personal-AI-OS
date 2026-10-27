import {canonical,check,digest} from '../contracts.ts';
import type {StoragePort} from '../storage.ts';
import type {PresentationResult} from '../../../../../../capability/contracts/presentation.ts';
import {validatePresentationOutline} from '../presentation-validate.ts';
import type {MeetingWorkspace,SnapshotRecord,PageRecord} from './ports.ts';
import {publishMeeting} from './plan.ts';

/** A separate document-tree record avoids claiming that a referenced cover was on the shared screen. */
export async function meetingPages(storage:StoragePort,workspace:MeetingWorkspace,record:SnapshotRecord,result:PresentationResult){
  const content=result.structuredContent.content.find(c=>c.key==='deck_outline');if(!content)return [];
  const outline=JSON.parse(content.text);validatePresentationOutline(outline);
  check(canonical(outline.target)===canonical(workspace.target)&&outline.deck_revision===record.snapshot.deck_revision&&
    outline.captured_at===record.snapshot.captured_at,'MEETING_OUTLINE_BINDING_INVALID');
  const {slides,version:_,...source}=outline;
  return Promise.all(slides.map(async slide=>{
    const page={...source,...slide},ref=`page:${digest([workspace.scope_session_id,record.ref,page])}`;
    return publishMeeting<PageRecord>(storage,'meeting-pages',workspace.principal_id,ref,
      {ref,principal_id:workspace.principal_id,scope_session_id:workspace.scope_session_id,snapshot_ref:record.ref,page});
  }));
}
export function explicitPageNumber(text:string):number|undefined|null {
  const numbers=new Set<number>();if(/封面/u.test(text))numbers.add(1);
  const chinese:Record<string,number>={'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
  for(const match of text.matchAll(/第\s*(\d+|[一二三四五六七八九十])\s*页/gu))numbers.add(chinese[match[1]!]??Number(match[1]));
  if(numbers.size>1)return null;return numbers.values().next().value;
}
export async function explicitMeetingPage(storage:StoragePort,workspace:MeetingWorkspace,snapshotRef:string,number:number){
  const candidates:PageRecord[]=[];
  for(const key of await storage.list('meeting-pages')){
    const row=JSON.parse(Buffer.from(await storage.read('meeting-pages',key)).toString()) as PageRecord;
    if(row.principal_id===workspace.principal_id&&row.scope_session_id===workspace.scope_session_id&&row.snapshot_ref===snapshotRef&&row.page.slide_number===number)candidates.push(row);
  }
  return candidates.length===1?candidates[0]:undefined;
}
