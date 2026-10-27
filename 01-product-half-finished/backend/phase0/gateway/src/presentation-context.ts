import {ToolListChangedNotificationSchema,type ListToolsResult} from '@modelcontextprotocol/sdk/types.js';
import type {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {meetingSelection} from '../../../services/personal-aios-integration/src/meeting/selection.ts';
import type {MeetingSelection} from '../../../services/personal-aios-integration/src/meeting/ports.ts';

/** Reuse tools/list metadata and its standard changed notification; never infer a document from the active window. */
export function watchPresentationContext(options:{client:Client;initial:ListToolsResult;current:()=>boolean;
  authorize:()=>Promise<void>;context:(value:MeetingSelection|null)=>Promise<void>;error:(error:unknown)=>void}){
  let closed=false,flight:Promise<void>|undefined;
  const consume=async(list:ListToolsResult)=>{
    if(closed||!options.current()||!list._meta||!Object.hasOwn(list._meta,'ai.yimi.presentation'))return;
    const value=list._meta['ai.yimi.presentation'];meetingSelection(value);await options.authorize();
    if(!closed&&options.current())await options.context(value);
  };
  const refresh=()=>flight??=(async()=>{await consume(await options.client.listTools(undefined,{timeout:10000}));})()
    .catch(options.error).finally(()=>{flight=undefined;});
  options.client.setNotificationHandler(ToolListChangedNotificationSchema,refresh);
  void consume(options.initial).catch(options.error);
  const timer=setInterval(()=>{if(!closed&&options.current())void refresh();},15000);timer.unref();
  return ()=>{closed=true;clearInterval(timer);};
}
