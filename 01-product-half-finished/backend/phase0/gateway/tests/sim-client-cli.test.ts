import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createServer} from 'node:http';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';

const tool=fileURLToPath(new URL('../tools/mac-product-sim-client.ts',import.meta.url));

/** Run the simulator in an empty folder beside a loopback origin that counts every request. */
async function run(t:test.TestContext,args:(folder:string,origin:string)=>string[]|Promise<string[]>){
  const folder=await fs.mkdtemp(join(tmpdir(),'sim-cli-'));let requests=0;
  const server=createServer((_,response)=>{requests++;response.writeHead(500).end();});
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(async()=>{server.close();await fs.rm(folder,{recursive:true,force:true});});
  const address=server.address();assert.ok(address&&typeof address!=='string');
  const origin=`http://127.0.0.1:${address.port}`,argv=await args(folder,origin),before=new Set(await fs.readdir(folder));
  const child=spawn(process.execPath,[tool,...argv],{cwd:folder,stdio:['ignore','pipe','pipe']});
  let stdout='',stderr='';child.stdout.setEncoding('utf8').on('data',text=>{stdout+=text;});child.stderr.setEncoding('utf8').on('data',text=>{stderr+=text;});
  const code=await new Promise<number|null>(resolve=>child.on('close',resolve));
  return {code,stdout,stderr,requests,created:(await fs.readdir(folder)).filter(name=>!before.has(name))};
}

test('simulator --help prints usage without reading pairing files, enrolling, writing state or contacting a server',async t=>{
  const result=await run(t,(folder,origin)=>['--help','--pairing',join(folder,'absent-pairing.json'),'--recipient-key',join(folder,'absent.jwk'),
    '--desktop',folder,'--enrollment',join(folder,'absent-enrollment.json'),'--origin',origin,'--prompt','synthetic']);
  assert.equal(result.code,0,result.stderr);assert.match(result.stdout,/^Usage: node tools\/mac-product-sim-client\.ts --pairing/u);
  assert.equal(result.stderr,'');assert.equal(result.requests,0);assert.deepEqual(result.created,[]);
});

test('simulator rejects missing required arguments with a short usage error before any side effect',async t=>{
  const result=await run(t,async(folder,origin)=>{
    const enrollment=join(folder,'enrollment.json');
    await fs.writeFile(enrollment,JSON.stringify({schema:'paios.mac-enrollment.v1',origin,token:'x'.repeat(43),expires_at:'2999-01-01T00:00:00Z'}));
    return ['--desktop',folder,'--enrollment',enrollment,'--origin',origin,'--prompt','synthetic'];
  });
  assert.equal(result.code,2);assert.equal(result.stdout,'');
  assert.match(result.stderr,/^error: missing required --pairing and --recipient-key\nUsage: /u);
  assert.equal(result.requests,0);assert.deepEqual(result.created,[]);
  const partial=await run(t,folder=>['--pairing',join(folder,'absent-pairing.json'),'--recipient-key','--prompt','synthetic']);
  assert.equal(partial.code,2);assert.match(partial.stderr,/^error: missing required --recipient-key\n/u);
});
