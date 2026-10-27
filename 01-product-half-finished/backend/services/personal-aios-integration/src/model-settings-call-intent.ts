import {canonical,check} from './contracts.ts';
import type {ModelRole,ModelSnapshot} from './model-settings-contract.ts';

/** RQ-115: copy configured routes, keeping the call classifier's own request budget. */
export function callIntentFallbackUpdate(snapshot:ModelSnapshot,profile:string):ModelRole|undefined {
  const brain=snapshot.roles.find(role=>role.profile===profile&&role.id==='brain');
  const intent=snapshot.roles.find(role=>role.profile===profile&&role.id==='call.intent');
  check(brain&&intent&&!brain.disabled&&!intent.disabled&&!intent.read_only&&
    brain.activation_boundary==='brain_idle'&&intent.activation_boundary==='brain_idle','MODEL_SETTINGS_CALL_INTENT_UNAVAILABLE',409);
  const ordered_fallbacks=brain.ordered_fallbacks.map(route=>({...structuredClone(route),
    parameters:{...structuredClone(route.parameters),...structuredClone(intent.parameters)}}));
  if(canonical(intent.ordered_fallbacks)===canonical(ordered_fallbacks))return undefined;
  // An operator-customized chain needs a separate review; this migration only adds the missing list.
  check(intent.ordered_fallbacks.length===0,'MODEL_SETTINGS_CALL_INTENT_FALLBACK_CONFLICT',409);
  return {...structuredClone(intent),ordered_fallbacks};
}
