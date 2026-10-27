import type {AdmissionEntry} from '../../admission.ts';
import type {ConsentCall} from './decision.ts';
import type {SendIdentity} from '../send-identity.ts';

/** Produced by the gateway after catalog resolution and trusted argument injection. */
export interface FrozenCall {
  tool_name:string; task_id:string; args:Record<string,unknown>; idempotency_key:string;
  consent:ConsentCall; admission:AdmissionEntry; check_with:string;
  package_digest?:string;
  package?:string;invocation?:string;
  send_identity?:SendIdentity;
}
