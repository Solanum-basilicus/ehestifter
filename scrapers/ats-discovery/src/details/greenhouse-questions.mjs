import { greenhouseHtmlToPlainText } from './greenhouse-text.mjs';

// Store question text only. Never store answers or applicant information.
const LOCATION_QUESTION = /\b(?:authori[sz](?:ed|ation)|sponsorship|visa|work\s+permit|right\s+to\s+work|residen(?:t|ce|cy)|resid(?:e|ing)|current\s+(?:city|state|country|location)|located\s+in|based\s+in|where\s+.*\blive|eligible\s+to\s+work)\b/iu;
const US_CONTEXT = /\b(?:united\s+states(?:\s+of\s+america)?|h-?1b)\b/iu;
const US_CODE = /(?:\b(?:US|USA)\b|\bU\.S\.A?\.?(?=\W|$))/u;

export function extractGreenhouseLocationQuestions(payload) {
  if (!Array.isArray(payload?.questions)) return [];
  const result = [];
  const seen = new Set();
  for (const question of payload.questions.slice(0, 120)) {
    // Greenhouse API question fields can contain inputs. Do not copy them.
    if (typeof question?.label !== 'string') continue;
    const label = greenhouseHtmlToPlainText(question.label).replace(/\s+/gu, ' ').trim().slice(0, 500);
    if (!LOCATION_QUESTION.test(label) || seen.has(label.toLowerCase())) continue;
    seen.add(label.toLowerCase());
    const kind = /\b(?:authori[sz](?:ed|ation|e)|sponsor(?:ship|ed)?|visa|permit|right\s+to\s+work)\b/iu.test(label)
      ? 'work_authorization' : 'residence_or_location';
    result.push({
      label,
      required: question.required === true,
      kind,
      countryHint: (US_CONTEXT.test(label) || US_CODE.test(label)) ? 'US' : null,
      source: 'greenhouse_application_question',
    });
    if (result.length >= 25) break;
  }
  return result;
}
