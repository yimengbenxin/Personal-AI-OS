import type {ToolSchema} from '../tool-contracts.ts';
import {PREFERENCES} from './preferences.ts';

export const personalityTool: ToolSchema = {
  name: 'paios_personality_zone',
  description: 'Read my platform-owned personality preferences/history, propose a change without saving, apply, or revert the last change (改回去). '
    + 'Changes use self_change with its existing rules. Only adjust after repeated owner feedback about tone/style/habits, never a one-off mood. '
    + 'Read current first and use expected_version; every apply/revert creates a version. Content is at most 1500 Unicode characters: empty for defaults, '
    + 'otherwise exact preference lines separated by newline, drawn only from: ' + PREFERENCES.join('；') + '。'
    + 'Never change identity, safety, first principle or protected baselines. After a committed receipt, tell the owner what changed in one short line.',
  parameters: {type: 'object', properties: {action: {enum: ['read', 'propose', 'apply', 'revert']},
    content: {type: 'string'}, expected_version: {type: 'integer', minimum: 0},
    offset: {type: 'integer', minimum: 0}, limit: {type: 'integer', minimum: 1, maximum: 50}},
    required: ['action'], additionalProperties: false, oneOf: [
      {properties: {action: {const: 'read'}}, not: {anyOf: [{required: ['content']}, {required: ['expected_version']}]}},
      {properties: {action: {enum: ['propose', 'apply']}}, required: ['content', 'expected_version'],
        not: {anyOf: [{required: ['offset']}, {required: ['limit']}]}},
      {properties: {action: {const: 'revert'}}, required: ['expected_version'],
        not: {anyOf: [{required: ['content']}, {required: ['offset']}, {required: ['limit']}]}}
    ]}
};
