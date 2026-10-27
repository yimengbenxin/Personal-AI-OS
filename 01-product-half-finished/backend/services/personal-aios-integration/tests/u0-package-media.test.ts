import test from 'node:test';
import assert from 'node:assert/strict';
import {CallToolResultSchema} from '@modelcontextprotocol/sdk/types.js';
import {desktopPackageResult} from '../../../../../capability/packages/desktop/server/receipt.ts';
import {withMedia} from '../../../../../capability/sdk/ts/mcp-media.ts';
import {unknown,to_mcp_result} from '../../../../../capability/sdk/ts/receipt.ts';

const image={type:'image',mimeType:'image/png',data:'AAAA'},resource={type:'resource',resource:{uri:'file:///fixture',text:'fixture'}};
const raw={content:[{type:'text',text:'MEDIA:/fixture/attachment.txt'},image,resource],structuredContent:{width:2,height:2}};
for(const family of ['desktop','ts-host'])test(`${family} preserves Image, Resource and MEDIA beside one receipt Text`,()=>{
  const original=structuredClone(raw),result=family==='desktop'?desktopPackageResult('window_capture',{},raw):withMedia(to_mcp_result(unknown()),raw);
  CallToolResultSchema.parse(result);
  assert.deepEqual(result.content.filter(block=>block.type!=='text'),[image,resource]);
  const text=result.content.filter(block=>block.type==='text');assert.equal(text.length,1);
  assert.ok(String(text[0]!.text).includes('MEDIA:/fixture/attachment.txt'));
  assert.equal(result.structuredContent.receipt,1);assert.deepEqual(raw,original);
});
