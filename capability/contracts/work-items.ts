import type {Receipt,State} from '../sdk/ts/receipt.ts';

/** Additive receipt projection, never a seventh fact kind or a second execution authority. */
export interface WorkItem {
  id:string;label:string;state:Exclude<State,'rejected'>;effect_refs:string[];
  slide_id?:string;slide_number?:number;
}
export type WorkItemReceipt=Receipt&{work_items?:WorkItem[]};
