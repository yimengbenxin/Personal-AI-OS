import {digest} from '../contracts.ts';
import type {Receipt, State} from '../../../../../../capability/sdk/ts/receipt.ts';
import type {Fact, ReceiptRecord} from './ledger.ts';
import {projectWorkItems} from './work-items.ts';

// Fixed fact-kind templates. Labels and contents come exclusively from the admitted receipt.
export const statusText: Record<State, [string, string]> = {
  succeeded: ['已完成。', '办好了。'], partial: ['部分完成。', '只完成了一部分。'],
  failed: ['未办成。', '这次没办成。'], unknown: ['结果尚未核实。', '结果还不清楚。'],
  running: ['正在执行。', '还在办。'], accepted: ['请求已接收，尚未确认完成。', '已接收，还没确认完成。'],
  waiting: ['正在等待。', '还在等。'], cancelled: ['已取消。', '已取消。'], rejected: ['请求被拦下，未执行。', '已拦下，没有执行。'],
};
const verification = {verified: '已核验', service_ack: '服务已确认', not_verified: '尚未核验', unknown: '核验结果未知'};
export const unitAliases:Record<string,string>={none:'',celsius:'°C','℃':'°C',摄氏度:'°C',度:'°C',percent:'%','％':'%',
  count:'个',次:'个',项:'个',处:'个',seconds:'秒',s:'秒',ms:'秒',milliseconds:'秒',minutes:'分钟',min:'分钟'};
export const displayUnit = (unit: string) => unitAliases[unit]??unit;
export function quantity(value:number,unit:string):{value:number;unit:string}{
  return {value:['ms','milliseconds'].includes(unit)?value/1000:value,unit:displayUnit(unit)};
}
const shownValue=(value:Receipt['values'][number])=>{
  if(typeof value.value==='number'){const shown=quantity(value.value,value.unit);return `${shown.value}${shown.unit}`;}
  return value.value===null?'未知':value.value===true?'是':value.value===false?'否':value.value;
};
function json(text:string):unknown{try{return JSON.parse(text);}catch{return undefined;}}
export function activitySentence(receipts:Receipt[],state:State):string {
  const labels=[...new Set(receipts.flatMap(receipt=>receipt.effects.map(effect=>effect.target.replace(/\s+/gu,' ').trim())))];
  const status=state==='waiting'&&receipts.some(receipt=>receipt.next.waiting_on==='owner')?'等待主人处理。':statusText[state][1];
  const sentence=(labels.length?labels.join('、')+'，':'')+status;
  return [...sentence].length<=48?sentence:status;
}
export function receiptFacts(receipts: Receipt[], origin?: string): Fact[] {
  const facts: Fact[] = [];
  const add = (kind: string, identity: unknown, text: string, voice = text, match: Partial<Fact> = {}) =>
    facts.push({id: digest({kind, identity, origin:origin??null}), kind, text, voice, ...match});
  for (const receipt of receipts) {
    const roots=[...new Set(receipt.values.filter(value=>value.value!==null).map(value=>value.key.split(/[.\[]/u)[0]!.split('的')[0]!))];
    const valuesLabel=roots.length<=3&&[...roots.join('、')].length<=48?roots.join('、'):'';
    const targets = [...new Set(receipt.effects.map(effect => effect.target))].join('、')||valuesLabel;
    const label = targets ? targets + '：' : '';
    add('status', [targets, receipt.status.state, receipt.status.reason_code??null], label + statusText[receipt.status.state][0],
      (targets ? targets + '，' : '') + statusText[receipt.status.state][1], {labels:targets?[targets]:[],state:receipt.status.state});
    if (receipt.status.progress) {
      const progress = receipt.status.progress;
      const done=quantity(progress.done,progress.unit),total=quantity(progress.total,progress.unit);
      add('progress', progress, `已完成 ${done.value}/${total.value} ${done.unit}。`,
        `${total.value}${total.unit}中完成了${done.value}${done.unit}。`,
        {quantities:[{value:progress.done,unit:progress.unit},{value:progress.total,unit:progress.unit}]});
    }
    for (const effect of receipt.effects) add('effect', effect,
      `${effect.target}的${effect.action}，${verification[effect.verification]}。`);
    const arrays=new Map<string,Receipt['values']>();
    for (const value of receipt.values) {
      const indexed=/^(.*?)\[\d+\]/u.exec(value.key);
      if(indexed){const key=indexed[1]||'列表',group=arrays.get(key)??[];group.push(value);arrays.set(key,group);continue;}
      if(value.value===null&&receipt.values.length===1&&receipt.content.some(content=>json(content.text)===null))continue;
      // as_of proves freshness but does not turn an otherwise unchanged fact into a new fact.
      const {as_of: _, ...identity} = value;
      const detail=receipt.content.map(content=>json(content.text)).map(raw=>value.key.split('.').reduce<unknown>((row,key)=>
        row&&typeof row==='object'?(row as Record<string,unknown>)[key]:undefined,raw)).find(Array.isArray);
      add('value', detail===undefined?identity:{...identity,detail}, `${value.key}：${shownValue(value)}，来源${value.source}。`,
        `${value.key}是${shownValue(value)}。`, {labels:[value.key,value.key.split('的')[0]!],value});
    }
    for(const [key,group]of arrays){
      const count=new Set(group.map(value=>/\[(\d+)\]/u.exec(value.key)![1])).size,missing=group.filter(value=>value.value===null).length;
      const unknown=missing?`，其中${missing}个值未知`:'';
      const first=group[0]!,value={...first,key,value:count,unit:'count',provenance:'computed' as const};
      add('value',group.map(({as_of:_,...value})=>value),`${key}：共${count}项${unknown}；详情已记录，可按需查看。`,
        `${key}共${count}项${unknown}，详情可再问。`,{labels:[key],value,summary:true,
          quantities:[{value:count,unit:'count'},...(missing?[{value:missing,unit:'count'}]:[])]});
    }
    for (const content of receipt.content){
      const raw=json(content.text);
      if(raw!==undefined&&typeof raw==='object'){
        if(receipt.values.length&&raw!==null)continue;
        const count=raw===null?0:Array.isArray(raw)?raw.length:Object.keys(raw).length;
        add('content',content,raw===null?'返回内容未知。':`内容共${count}项，详情已记录，可按需查看。`,
          raw===null?'返回内容未知。':`有${count}项内容，详情可再问。`,{summary:true,quantities:count?[{value:count,unit:'count'}]:[]});
      }else add('content',content,typeof raw==='string'?raw:`${content.key}：${content.text}`);
    }
    for (const unknown of receipt.unknowns) add('unknown', unknown, `${unknown.about}尚不清楚：${unknown.why}。`, `${unknown.about}还不清楚，${unknown.why}。`);
    if (receipt.next.waiting_on !== 'none') {
      const detail=receipt.next.waiting_detail || ({owner: '在等你确认。', external: '在等外部结果。', time: '在等约定时间。'}[receipt.next.waiting_on]);
      add('next', receipt.next, /[。！？]$/u.test(detail)?detail:detail+'。');
    }
    if (receipt.next.retry === 'after_check') add('retry', [targets, receipt.next], '需要先核查结果，再决定是否重试。', '先查清结果，再决定要不要重试。');
    if (receipt.next.retry === 'forbidden' && receipt.status.state === 'succeeded' && receipt.effects.length)
      add('retry', [targets, receipt.next], '这件事无需重复执行。', '不用再做一次。');
  }
  return [...new Map(facts.map(fact => [fact.id, fact])).values()];
}
/** Fresh calls are fresh observations/effects. Follow-ups reuse the same recorded call; jobs keep one causal identity. */
export function recordFacts(records:ReceiptRecord[],run:string):Fact[] {
  const facts=records.flatMap(record=>receiptFacts([record.receipt],record.receipt.job?`job:${record.receipt.job.id}`:digest([record.origin_run??run,record.call_id??record.id])));
  const items=projectWorkItems(records);
  if(items.length){const done=items.filter(item=>item.state==='succeeded').length,total=items.length;
    facts.push({id:digest({kind:'progress',items}),kind:'progress',text:`已核验 ${done}/${total} 处。`,voice:`${total}处中核验完成${done}处。`,
      quantities:[{value:done,unit:'count'},{value:total,unit:'count'}]});}
  return facts;
}
export const MAX_RENDERED_FACTS=12,MAX_FACT_CHARACTERS=160;
export interface ReportBudget {max_characters:number}
export const factText=(fact:Fact,outlet:'text'|'voice')=>fact[outlet].replace(/\s+/gu,' ').trim();
/** Display equality does not merge causal identities or acknowledge deferred details. */
export function projectFacts(facts:Fact[],outlet:'text'|'voice',budget?:ReportBudget):{visible:Fact[];deferred:Fact[];notice:string}{
  const priority=['status','effect','unknown','next','retry','progress','value','content'];
  const rank=(fact:Fact)=>budget?(fact.kind==='unknown'?0:fact.state&&['unknown','partial','failed','cancelled','rejected'].includes(fact.state)?1:
    fact.kind==='next'?2:fact.kind==='progress'?3:fact.kind==='status'?4:5):priority.indexOf(fact.kind);
  const unique=[...new Set([...facts].sort((a,b)=>rank(a)-rank(b)).map(fact=>factText(fact,outlet)))];
  const selected=new Set<string>();let used=0;
  for(const text of unique){const length=[...text].length;
    if(length>MAX_FACT_CHARACTERS||selected.size>=MAX_RENDERED_FACTS||budget&&used+length+1>budget.max_characters-9)continue;
    selected.add(text);used+=length+1;}
  const visible=facts.filter(fact=>selected.has(factText(fact,outlet))),deferred=facts.filter(fact=>!selected.has(factText(fact,outlet)));
  const notice=deferred.length?(budget?'其余详情可再问。':`共${unique.length}项事实，已记录；本次展示${selected.size}项，其余可按需查看。`):'';
  return {visible,deferred,notice};
}
export const renderFacts = (facts: Fact[], outlet: 'text'|'voice',budget?:ReportBudget) => {
  const projection=projectFacts(facts,outlet,budget);
  return [...new Set(projection.visible.map(fact=>factText(fact,outlet))),projection.notice].filter(Boolean).join(outlet==='text'?'\n':'');
};
