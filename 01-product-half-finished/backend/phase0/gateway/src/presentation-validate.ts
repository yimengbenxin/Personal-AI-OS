import {Ajv} from 'ajv';
import addFormats from 'ajv-formats';
import {createPresentationValidators,type PresentationValidators} from '../../../../../capability/contracts/presentation-validate.ts';
export {presentationSchema,presentationTools,textPlanHash,type DesktopTargetBinding} from '../../../../../capability/contracts/presentation-validate.ts';

const ajv=new Ajv({strict:true});
addFormats.default(ajv,['date-time']);
const validators:PresentationValidators=createPresentationValidators(ajv);
export const validateTextPlan:PresentationValidators['validateTextPlan']=validators.validateTextPlan;
export const validatePresentationInput:PresentationValidators['validatePresentationInput']=validators.validatePresentationInput;
export const validateSlideSnapshot:PresentationValidators['validateSlideSnapshot']=validators.validateSlideSnapshot;
export const validateMacEditResult:PresentationValidators['validateMacEditResult']=validators.validateMacEditResult;
export const validatePresentationOutline:PresentationValidators['validatePresentationOutline']=validators.validatePresentationOutline;
