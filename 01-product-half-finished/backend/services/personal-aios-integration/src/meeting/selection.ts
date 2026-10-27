import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';
import {readFileSync} from 'node:fs';
import {presentationSchema} from '../presentation-validate.ts';
import {check} from '../contracts.ts';
import type {MeetingSelection} from './ports.ts';
const schema=JSON.parse(readFileSync(new URL('../../../../../../integrations/contracts/presentation-context.v1.schema.json',import.meta.url),'utf8'));
const ajv=new Ajv({strict:true});addFormats.default(ajv);ajv.addSchema(presentationSchema);const validate=ajv.compile(schema);
export function meetingSelection(input:unknown):asserts input is MeetingSelection|null {check(validate(input),'MEETING_SELECTION_INVALID');}
