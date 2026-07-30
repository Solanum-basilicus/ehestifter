import {
  decodeHtmlEntities,
  htmlToPlainText,
} from './text.mjs';

const RAW_HTML_TAG_RE = /<\/?[a-z][^<>]*>/i;
const ENCODED_HTML_TAG_RE = /&lt;\/?[a-z][\s\S]*?&gt;/i;
const GREENHOUSE_TEXT_ENTITIES = new Map([
  ['mdash', '—'],
  ['ndash', '–'],
  ['hellip', '…'],
  ['lsquo', '‘'],
  ['rsquo', '’'],
  ['ldquo', '“'],
  ['rdquo', '”'],
]);

function decodeGreenhouseTextEntities(value) {
  return decodeHtmlEntities(value).replace(
    /&(mdash|ndash|hellip|lsquo|rsquo|ldquo|rdquo);/gi,
    (match, entity) => (
      GREENHOUSE_TEXT_ENTITIES.get(entity.toLowerCase()) ?? match
    ),
  );
}

function normalizePlainText(value) {
  return value
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function greenhouseHtmlToPlainText(value) {
  const source = typeof value === 'string' ? value : '';
  const isEncodedHtml = !RAW_HTML_TAG_RE.test(source)
    && ENCODED_HTML_TAG_RE.test(source);
  if (!isEncodedHtml) return htmlToPlainText(source);

  // Greenhouse returns hosted-editor markup with angle brackets encoded.
  // Decode only structural brackets before stripping tags. Text entities are
  // decoded afterwards so double-encoded content such as &amp;nbsp; is handled
  // without turning literal escaped markup into active HTML.
  const html = source
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(
      /<\/\s*(p|div|h[1-6]|section|article|ul|ol)\s*>/gi,
      '$&\n',
    );
  return normalizePlainText(
    decodeGreenhouseTextEntities(htmlToPlainText(html)),
  );
}
