/** Production memory admission/issuer/repository over the isolated PostgreSQL fixture. */
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createPostgresPool} from '../../01-product-half-finished/backend/services/platform-data/src/postgres-pool.ts';
import {createMemoryAuthorityRepository} from '../../01-product-half-finished/backend/services/platform-data/src/memory-authority-repository.ts';
import {admitMemoryProposal} from '../../01-product-half-finished/backend/services/memory-os/src/admission.ts';
import {createCanonicalObjectVersionRef,assertSha256} from '../../01-product-half-finished/backend/services/memory-os/src/canonical-ref.ts';
import {createProductionMemoryCanonicalIssuer,assertProductionMemoryIssuerReceipt,projectProductionMemoryIssuerReceipt,rehydrateProductionMemoryIssuerReceipt} from '../../01-product-half-finished/backend/services/memory-os/src/canonical-issuer.ts';

const pool=createPostgresPool(JSON.parse(process.argv[2]!));
try {
  const mode=process.argv[3]!;
  const evidence=createCanonicalObjectVersionRef({refType:'Observation',refId:'01900000-0000-7000-8000-000000000001',objectVersion:'1',canonicalPayloadSha256:assertSha256('a'.repeat(64))});
  const admitted=admitMemoryProposal({proposalId:'null-'+mode,intent:{kind:'create'},userId:'null-owner',kind:'preference_memory',slot:'null.'+mode,
    value:mode==='mandatory'?null:{text:'valid'},...(mode==='nullable'?{conflict:null}:{}),
    sourceClass:'explicit_user_preference',evidenceRefs:[evidence],confidencePpm:1000000,purposeScopes:['conversation','memory'],
    sensitivity:{classification:'normal',userConfirmed:true},validity:{observedAt:'2026-08-25T00:00:00.000Z'},idempotencyKey:'null-'+mode});
  assert.equal(admitted.status,'candidate');
  if(admitted.status!=='candidate')throw Error(JSON.stringify(admitted));
  const issuer=createProductionMemoryCanonicalIssuer({nowMs:()=>1700000060000n});
  const receipt=issuer.issueCandidate({candidate:admitted.intent,context:{systemTime:'2026-08-25T00:00:00.000000Z'}});
  const repository=createMemoryAuthorityRepository(pool,{canonicalCodec:{assertReceipt:assertProductionMemoryIssuerReceipt,projectReceipt:projectProductionMemoryIssuerReceipt,rehydrateReceipt:rehydrateProductionMemoryIssuerReceipt}});
  const result=await repository.appendCanonical({idempotencyKey:'append-'+mode,
    fingerprint:assertSha256(createHash('sha256').update('append-'+mode).digest('hex')),receipt});
  assert.equal(result.ok,true,JSON.stringify(result));
} finally {
  await pool.end();
}
