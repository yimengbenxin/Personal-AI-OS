import {value,unknown_fact,type Value,type Unknown} from './receipt.ts';

const units: Record<string, string> = {
  bytes: 'byte', selected_bytes: 'byte', total_bytes: 'byte', latitude: 'degree', longitude: 'degree', lat: 'degree', lng: 'degree',
  accuracy: 'm', altitude: 'm', distance: 'm', speed: 'm/s', heart_rate: 'count/min', count: 'count', samples: 'count',
  done: 'count', total: 'count', deleted_events: 'count', erased_versions: 'count', version: 'none', revision: 'none',
  offset: 'none', next_offset: 'none', next_cursor: 'none', category: 'category-code', type: 'category-code',
  confidence: 'none', similarity: 'none', minutes: 'min', dur: 's', energy: 'kcal', dist: 'm',
  attempts: 'count', unknown_attempts: 'count', foreign_currency_attempts: 'count', observed_days: 'day',
};
const computed = new Set(['mean', 'avg', 'average', 'avg_7d', 'delta_from_7d_avg', 'observed_days', 'sum', 'min', 'max', 'count', 'samples', 'duration', 'distance_m', 'eta_s', 'known_cny', 'estimated_cny']);
const hasUnknown=(raw:unknown):boolean=>raw===null||typeof raw==='object'&&Object.values(raw!).some(hasUnknown);

/** The same typed evidence serves compact package receipts and on-demand detail verification. */
export function resultFacts(raw:unknown,now:string,source:string,aggregateLists=true):{values:Value[];unknowns:Unknown[]} {
  const values:Value[]=[],unknowns:Unknown[]=[];
  function walk(raw:unknown,key:string,inherited:{unit?:string|undefined;as_of:string;source:string;estimated?:boolean},field=''):void {
    if(typeof raw==='number'||typeof raw==='boolean'||raw===null){
      if(raw===null&&!key)return;
      let unit=units[field]??(/_ms$/u.test(field)?'ms':/_m$/u.test(field)?'m':/_s$/u.test(field)?'s':
        /_min$/u.test(field)?'min':/_(?:yuan|cny)$/u.test(field)?'CNY':/_usd$/u.test(field)?'USD':/_fen$/u.test(field)?'fen':
        /_tokens$/u.test(field)?'token':['value','mean','avg','average','sum','min','max','latest','last','avg_7d','delta_from_7d_avg','amount'].includes(field)?inherited.unit??'none':'none');
      if(typeof raw==='boolean'||raw===null)unit='none';
      values.push(value(key||'返回值',raw,unit,computed.has(field)||inherited.estimated?'computed':'observed',inherited.source,inherited.as_of));
    }else if(Array.isArray(raw)){
      if(aggregateLists){
        values.push(value(key||'列表',raw.length,'count','computed',inherited.source,inherited.as_of));
        if(hasUnknown(raw))unknowns.push(unknown_fact(key||'列表','列表中有未知值，详情可按需查看'));
      }else raw.forEach((item,index)=>walk(item,`${key}[${index}]`,inherited,field));
    }else if(raw&&typeof raw==='object'){
      const row=raw as Record<string,any>,observed=row.observed_at??row.committed_at??row.recorded_at??row.captured_at;
      const clock=typeof observed==='string'&&Number.isFinite(Date.parse(observed))?observed:
        typeof row.start_ms==='number'?new Date(row.start_ms).toISOString():inherited.as_of;
      const context={unit:typeof row.unit==='string'?row.unit:typeof row.currency==='string'?row.currency:inherited.unit,
        as_of:clock,source:typeof row.source==='string'?row.source:inherited.source,estimated:row.kind==='estimated'||inherited.estimated===true};
      for(const [name,item]of Object.entries(row))walk(item,key?`${key}.${name}`:name,context,name);
    }
  }
  walk(raw,'',{as_of:now,source});
  return {values,unknowns};
}
