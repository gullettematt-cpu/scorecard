// Everything the API shares with the app: domain rules, the text engine, strings, checklists, rollout.
import en from '../../../i18n/en.json' with { type: 'json' };
import es from '../../../i18n/es.json' with { type: 'json' };
import rollout from '../../../config/rollout.json' with { type: 'json' };
import drawRules from '../../../web/content/draw-rules.json' with { type: 'json' };
import windows from '../../../web/content/checklists/windows.json' with { type: 'json' };
import siding from '../../../web/content/checklists/siding.json' with { type: 'json' };

export const strings = { en, es };
export const checklists = { windows, siding };
export { rollout, drawRules };
export { createEngine } from '../../../web/src/sms/engine.js';
export { makeTranslator, detectLang } from '../../../web/src/translate.js';
export { vistaOn } from '../../../web/src/rollout.js';
export * as domain from '../../../web/src/data.js';

export const MANIFEST_FIELD = 'Additional_Work_Performed_Description__c';
export const MANIFEST_MARK = '<!--vista-manifest-->';
export function readManifest(fieldValue) {
  const raw = fieldValue || '';
  const i = raw.indexOf(MANIFEST_MARK);
  if (i < 0) return {};
  try { return JSON.parse(raw.slice(i + MANIFEST_MARK.length)); } catch { return {}; }
}
export const writeManifest = (m, note = '') => `${note ? note + '\n\n' : ''}${MANIFEST_MARK}${JSON.stringify(m)}`;

// Case (problem report) picklists, exactly as in Salesforce (docs/data-contract.md).
export const CASE_PICKLISTS = {
  Work_Type__c: ['Baths', 'Cover', 'Door', 'Gutters', 'Insulation', 'Rainsoft', 'Roofing', 'Siding', 'Window', 'Cabinet'],
  Service_Type__c: ['Paid Service', 'Warranty'],
  Warranty_Type__c: ['Installer Warranty', 'Company Warranty', 'Sales/Service', 'Customer Accommodation']
};
export const SERVICE_RECORD_TYPE = '0124P000000OMP8QAO';
