import test from 'node:test';
import assert from 'node:assert/strict';
import {peopleFixture,peopleRows} from './people-fixture.ts';
import {prepareCall} from '../../../../../capability/packages/ts-personal/server/index.ts';

test('127 people: default source response contains counts and named entries, below native MCP spillover',async t=>{
  const f=await peopleFixture(t),wire=await f.call('paios_people'),body=wire.structuredContent;
  const raw=JSON.parse(body.content[0]!.text);
  assert.equal(body.status.state,'succeeded');
  assert.ok(JSON.stringify(wire).length<50000,'full MCP envelope must fit native threshold');
  assert.equal(raw.people.length,3);assert.equal(raw.nearby.length,3);
  assert.deepEqual(raw.counts,{total:127,named:{count:3},unnamed:{count:124},stale_models:{count:43}});
  assert.deepEqual(raw.people,peopleRows().slice(124));
  for(const key of ['counts.total','counts.named.count','counts.unnamed.count','counts.stale_models.count']){
    const value=body.values.find(row=>row.key===key)!;
    assert.equal(value.unit,'count');assert.equal(value.source,'platform:paios_people');assert.ok(value.as_of);
  }
});

test('people detail filters and paging recover all unnamed rows and cap both result lists',async t=>{
  const f=await peopleFixture(t),found:unknown[]=[];
  for(let offset=0;offset<124;offset+=20){
    const wire=await f.call('paios_people',{filter:'unnamed',offset,limit:20});
    assert.equal(wire.structuredContent.status.state,'succeeded');
    const raw=JSON.parse(wire.structuredContent.content[0]!.text);found.push(...raw.people);
    assert.equal(raw.page.total,124);assert.equal(raw.page.next_offset,offset+20<124?offset+20:null);
    assert.ok(raw.nearby.length<=20);assert.ok(JSON.stringify(wire).length<50000);
  }
  assert.deepEqual(found,peopleRows().slice(0,124));
  assert.equal(prepareCall('paios_people',{filter:'all',offset:20,limit:20}).args._operation,'read');
  const all=await f.call('paios_people',{filter:'all',limit:1});
  assert.equal(JSON.parse(all.structuredContent.content[0]!.text).page.total,127);
});
