import type {Receipt, State} from '../../../../../../capability/sdk/ts/receipt.ts';
import type {Fact} from './ledger.ts';
import {displayUnit, renderFacts, receiptFacts,unitAliases,quantity,factText,projectFacts,MAX_RENDERED_FACTS,MAX_FACT_CHARACTERS} from './renderer.ts';
import {resultFacts} from '../../../../../../capability/sdk/ts/result-values.ts';

// One lexicon per status class, independent of capability identity.
export const statusLexicon: Record<State, string[]> = {
  succeeded: ['办好了', '办完了', '办成了', '流程走完了', '关好了', '打开了', '已完成', '完成了', '全部完成', '已经完成', '已经成功', '成功了', '已记下', '记下了', '已保存', '保存好了', '已记录', '记住了', '留着了', '已关闭', '已打开', '已设置', '已连接'],
  partial: ['部分完成', '完成了一部分', '只完成了一部分', '只成了一半'],
  failed: ['失败了', '失败', '未办成', '没办成', '没成', '操作失败'],
  unknown: ['结果未知', '结果还不清楚', '结果尚未核实', '尚不清楚', '不能确认完成', '无法确认完成'],
  running: ['正在执行', '正在处理', '还在办', '还在做', '正在办'],
  accepted: ['已接收', '已受理', '尚未确认完成', '还没确认完成', '已提交', '提交成功', '接收成功'],
  waiting: ['正在等待', '还在等', '等待你', '等你扫码'],
  cancelled: ['已取消', '取消了'], rejected: ['已拦下', '被拦下', '没有执行'],
};
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
const mentions=(text:string,label:string)=>{
  const at=text.indexOf(label);return at>=0&&!/[A-Za-z_.\[]/u.test(text[at+label.length]??'');
};
const asserted = (text:string) => text.replace(/没有失败|并未失败|并非失败|不代表失败|不能说失败/gu,'');
const phrases = Object.entries(statusLexicon).flatMap(([state, words]) => words.map(word => ({state: state as State, word}))).sort((a, b) => b.word.length - a.word.length);
function statusClaims(text:string):State[] {
  let rest=asserted(text);const states:State[]=[];
  for(const {state,word} of phrases)if(rest.includes(word)){states.push(state);rest=rest.replaceAll(word,'');}
  return states;
}
function normalizeNumbers(text: string): string {
  return text.normalize('NFKC').replace(/[零〇一二两三四五六七八九十百千万]+(?:点[零〇一二三四五六七八九]+)?(?=摄氏度|度|°C|%|台|个|次|份|项|处|分钟|小时|秒|元|米)/gu, token=>{
    const digits:Record<string,number>={零:0,〇:0,一:1,二:2,两:2,三:3,四:4,五:5,六:6,七:7,八:8,九:9};
    const [integer,fraction]=token.split('点');let total=0,section=0,current=0;
    for(const char of integer!) {
      if(char in digits){current=digits[char]!;continue;}
      const scale=({十:10,百:100,千:1000,万:10000} as Record<string,number>)[char]!;
      if(scale===10000){total+=(section+current)*scale;section=0;}else section+=(current||1)*scale;
      current=0;
    }
    return String(total+section+current)+(fraction?'.'+[...fraction].map(char=>digits[char]).join(''):'');
  });
}
export function factCarried(fact: Fact, text: string, outlet: 'text'|'voice', context:Fact[]=[fact]): boolean {
  if(text.replace(/\s+/gu,' ').includes(factText(fact,outlet)))return true;
  if(fact.summary)return false;
  if(fact.state)return statusClaims(text).includes(fact.state) &&
    (!context.some(other=>other.labels?.some(label=>text.includes(label)))||!fact.labels?.length||fact.labels.some(label=>text.includes(label)));
  if(fact.value && fact.labels?.some(label=>mentions(text,label))) {
    if(typeof fact.value.value!=='number'){
      const tail=text.slice(text.indexOf(fact.value.key)+fact.value.key.length);
      const declared=/^(?:[:：=]|是|为)\s*(.*?)(?:[，。！？!?]|$)/u.exec(tail)?.[1]?.trim();
      return declared!==undefined&&(fact.value.value===null?/^(?:未知|不清楚|null)$/u.test(declared):
        typeof fact.value.value==='boolean'?(fact.value.value?/^(?:是|true)$/u:/^(?:否|false)$/u).test(declared):declared===fact.value.value);
    }
    const suffixes=[...new Set([fact.value.unit,displayUnit(fact.value.unit),...Object.keys(unitAliases).filter(alias=>displayUnit(alias)===displayUnit(fact.value!.unit))])]
      .filter(suffix=>suffix!=='none').sort((a,b)=>b.length-a.length);
    const measurement=new RegExp(`(?<![\\d.])([-+]?\\d+(?:\\.\\d+)?)\\s*(${suffixes.map(escape).join('|')})(?![\\d.A-Za-z%°])`,'gu');
    const expected=quantity(fact.value.value,fact.value.unit);
    return [...normalizeNumbers(text).matchAll(measurement)].some(match=>{
      const actual=quantity(Number(match[1]),match[2]!);return actual.value===expected.value&&actual.unit===expected.unit;
    });
  }
  return false;
}
export interface CheckDecision {text: string; removed: {sentence: string; reasons: string[]}[]; fact_ids: string[]; facts: Fact[];
  missing_fact_ids:string[];deferred_fact_ids:string[];missing_summary:boolean}
/** Zero model calls. The output journal freezes both the decision and its receipt/novelty snapshot. */
export function checkReport(text: string, receipts: Receipt[], ownerInput: string, facts: Fact[], outlet: 'text'|'voice' = 'text', allFacts:Fact[]=facts.length?facts:receiptFacts(receipts),budget?:import('./renderer.ts').ReportBudget): CheckDecision {
  const values = receipts.flatMap(receipt => [...receipt.values,...receipt.content.flatMap(content=>{
    try{return resultFacts(JSON.parse(content.text),receipt.status.ended_at??'',content.key,false).values;}catch{return [];}
  })]);
  const projection=projectFacts(facts,outlet,budget),visibleIds=new Set(projection.visible.map(fact=>fact.id));
  const quantities=[...values,...allFacts.flatMap(fact=>[...(fact.value?[fact.value]:[]),...(fact.quantities??[])])];
  const novelIds=new Set(facts.map(fact=>fact.id));
  const units = [...new Set([...Object.keys(unitAliases), ...quantities.flatMap(value=>[value.unit,displayUnit(value.unit)]), '°C', '%', '元', '个', '次', '项', '秒', '分钟', '小时', '米', '公里', 'kg', 'mL'])].filter(Boolean).sort((a, b) => b.length - a.length);
  const number = new RegExp(`[-+]?\\d+(?:[.,]\\d+)*(?:\\s*(?:${units.map(escape).join('|')}))?`, 'gu');
  const parseNumber = (token: string) => {
    const parts = /^([-+]?\d+(?:[.,]\d+)*)\s*(.*)$/u.exec(token)!;
    return quantity(Number(parts[1]!.replace(/,(?=\d{3}(?:\D|$))/gu, '')),parts[2]!);
  };
  const supplied = [...normalizeNumbers(ownerInput).matchAll(number)].map(match => parseNumber(match[0]));
  const removed: CheckDecision['removed'] = [], kept: string[] = [],keptFacts:string[]=[],carriedIds=new Set<string>();
  let extra=MAX_RENDERED_FACTS-new Set(projection.visible.map(fact=>factText(fact,outlet))).size,hasNotice=false;
  const keepFact=(sentence:string,claimed:Fact[])=>{
    const ids=claimed.map(fact=>fact.id),line=sentence.trim();
    if(keptFacts.includes(line)||ids.length&&ids.every(id=>carriedIds.has(id))){removed.push({sentence,reasons:['duplicate_fact']});return;}
    const canonical=ids.some(id=>visibleIds.has(id));
    if([...line].length>MAX_FACT_CHARACTERS||!canonical&&extra<=0){removed.push({sentence,reasons:['fact_budget']});return;}
    if(!canonical)extra--;
    ids.forEach(id=>carriedIds.add(id));keptFacts.push(line);
  };
  for (const sentence of text.match(/[^。！？!?\n]+[。！？!?]?|\n/gu) ?? []) {
    if (!sentence.trim()) continue;
    if(projection.notice&&sentence.trim()===projection.notice){hasNotice=true;continue;}
    // Typed system facts are bound to admitted evidence; free prose retains its checks.
    const systemFacts=allFacts.filter(fact=>(fact.summary||fact.kind!=='content')&&factText(fact,outlet)===sentence.trim());
    if(systemFacts.length){
      if(systemFacts.some(fact=>novelIds.has(fact.id)))keepFact(sentence,systemFacts.filter(fact=>novelIds.has(fact.id)));
      else removed.push({sentence,reasons:['already_reported']});
      continue;
    }
    let normalized = normalizeNumbers(sentence);
    for(const key of [...new Set(values.map(value=>value.key))].sort((a,b)=>b.length-a.length))normalized=normalized.replaceAll(key,'');
    const reasons: string[] = [];
    const targetedValues=[...values,...allFacts.flatMap(fact=>fact.value?[fact.value]:[])].filter(value=>mentions(sentence,value.key));
    const longest=Math.max(0,...targetedValues.map(value=>value.key.length));
    const expected=targetedValues.length?targetedValues.filter(value=>value.key.length===longest):quantities;
    for(const value of targetedValues.filter(value=>value.key.length===longest)){
      const tail=sentence.slice(sentence.indexOf(value.key)+value.key.length);
      const declared=/^(?:[:：=]|是|为)\s*(.*?)(?:[，。！？!?]|$)/u.exec(tail)?.[1]?.trim();
      if(declared!==undefined&&(value.value===null&&!/未知|不清楚|null/u.test(declared)||
        typeof value.value==='boolean'&&/^(?:是|否|true|false)$/u.test(declared)&&/^(?:是|true)$/u.test(declared)!==value.value))reasons.push('value_conflict');
    }
    for (const match of normalized.matchAll(number)) {
      const claim = parseNumber(match[0]);
      const compatible = (expected: {value: number; unit: string}) => claim.value === expected.value && claim.unit === expected.unit;
      if (!supplied.some(compatible) && !expected.some(value => typeof value.value === 'number' && compatible(quantity(value.value,value.unit)))) reasons.push('unsupported_number');
    }
    const targeted = receipts.filter(receipt => receipt.effects.some(effect => sentence.includes(effect.target)) || receipt.values.some(value => sentence.includes(value.key)));
    const relevant = targeted.length ? targeted : receipts;
    // Consume longer phrases first: "尚未确认完成" must not turn into a succeeded claim.
    for (const state of statusClaims(sentence)) {
      if (!relevant.every(receipt => receipt.status.state === state || state === 'waiting' && receipt.next.waiting_on !== 'none')) reasons.push('status_conflict');
    }
    if (/再(?:次|来|做|试|执行)|重新(?:执行|操作|尝试)|重做|重试/gu.test(sentence) &&
        !/不用|无需|不必|不要|禁止/gu.test(sentence) && relevant.some(receipt => receipt.next.retry === 'forbidden')) reasons.push('retry_forbidden');
    if (/已记下|记下了|已保存|保存好了|已记录|记住了|留着了/gu.test(sentence) && !relevant.some(receipt => receipt.effects.some(effect =>
        ['owner_data', 'workspace'].includes(effect.kind) && ['verified', 'service_ack'].includes(effect.verification)))) reasons.push('effect_unproven');
    const claimed=allFacts.filter(fact=>factCarried(fact,sentence,outlet,allFacts));
    if(claimed.length && claimed.every(fact=>!novelIds.has(fact.id)))reasons.push('already_reported');
    if (reasons.length) removed.push({sentence, reasons: [...new Set(reasons)]});
    else if(claimed.length||targetedValues.length&&([...normalized.matchAll(number)].length||targetedValues.some(value=>
      /^(?:[:：=]|是|为)/u.test(sentence.slice(sentence.indexOf(value.key)+value.key.length)))))keepFact(sentence,claimed.filter(fact=>novelIds.has(fact.id)));
    else kept.push(sentence);
  }
  const remaining=[...keptFacts,...kept].join('');
  const selected = projection.visible.filter(fact => !factCarried(fact,remaining,outlet,allFacts));
  const rendered = renderFacts(selected, outlet,budget);
  const missingSummary=!!projection.notice&&!hasNotice;
  const proposed = removed.length||selected.length||missingSummary ? [rendered,...keptFacts,projection.notice,kept.join('')].filter(Boolean).join(outlet === 'text' ? '\n' : '') : text;
  // A presentation budget never truncates a fact. Unspoken facts stay deferred until actually delivered.
  const result=budget&&[...proposed].length>budget.max_characters?renderFacts(facts,outlet,budget):proposed;
  const carried = facts.filter(fact => factCarried(fact,result,outlet,allFacts));
  return {text: result, removed, fact_ids: carried.map(fact => fact.id), facts: carried,
    missing_fact_ids:selected.map(fact=>fact.id),deferred_fact_ids:projection.deferred.map(fact=>fact.id),missing_summary:missingSummary};
}
