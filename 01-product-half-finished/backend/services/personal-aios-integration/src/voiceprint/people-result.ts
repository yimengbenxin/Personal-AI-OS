import type {ClusterView} from './registry.ts';

export interface PeopleQuery {filter?: 'named'|'unnamed'|'all'; offset?: number; limit?: number}

/** Read summaries and pages share the registry's current evidence, never a second people store. */
export function peopleResult(people:ClusterView[],nearby:ClusterView[],query:PeopleQuery){
  const {filter='named',offset=0,limit=20}=query;
  const named=(person:ClusterView)=>Boolean(person.display_name);
  const matches=(person:ClusterView)=>filter==='all'||named(person)===(filter==='named');
  function page(rows:ClusterView[]){
    const selected=rows.filter(matches);
    return {rows:selected.slice(offset,offset+limit),page:{filter,total:selected.length,offset,limit,
      next_offset:offset+limit<selected.length?offset+limit:null}};
  }
  const selected=page(people),present=page(nearby),namedCount=people.filter(named).length;
  return {counts:{total:people.length,named:{count:namedCount},unnamed:{count:people.length-namedCount},
    stale_models:{count:people.filter(person=>person.stale_model).length}},
    people:selected.rows,page:selected.page,nearby:present.rows,nearby_page:present.page};
}
