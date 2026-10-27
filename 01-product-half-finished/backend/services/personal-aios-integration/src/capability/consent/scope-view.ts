import {check} from '../../contracts.ts';
import type {ConsentCall} from './decision.ts';
import type {ScopeConfirmationView} from '../../../../../../../capability/contracts/scope-grant.ts';

/** An owner-unlock terminal gets only scope and previews, not frozen invocation/admission internals. */
export function scopeConfirmation(call:ConsentCall):ScopeConfirmationView|undefined {
  if(!call.scope?.request)return;
  const previews=call.preview_items??(call.summary?[call.summary]:[]);
  check(Array.isArray(previews)&&previews.length<=64&&previews.every(item=>typeof item==='string'&&
    item.trim().length>0&&item.length<=240),'SCOPE_PREVIEW_INVALID');
  return structuredClone({grant_request:call.scope.request,preview_items:previews});
}
