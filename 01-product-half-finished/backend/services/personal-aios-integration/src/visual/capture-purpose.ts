import type {MeetingObservations} from '../meeting/observations.ts';
/** Purpose selection precedes generic caption, embedding and face/person associations. L5 still owns original bytes. */
export async function meetingCapture(meetings:MeetingObservations,principal:string,device:string,captured_at:string){
  const at=Date.parse(captured_at);return meetings.purpose(principal,device,{kind:'interval',timebase_id:'utc_epoch_ms',start_ms:at,end_ms:at+1});
}
