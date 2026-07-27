const NAMED_ENTITIES = new Map([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ['nbsp', ' '],
]);

function decodeEntity(match, entity) {
  const normalized = entity.toLowerCase();
  if (normalized.startsWith('#x')) {
    const codePoint = Number.parseInt(normalized.slice(2), 16);
    return Number.isInteger(codePoint) && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  }
  if (normalized.startsWith('#')) {
    const codePoint = Number.parseInt(normalized.slice(1), 10);
    return Number.isInteger(codePoint) && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : match;
  }
  return NAMED_ENTITIES.get(normalized) ?? match;
}

export function decodeHtmlEntities(value) {
  if (typeof value !== 'string' || value === '') return '';
  return value.replace(
    /&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi,
    decodeEntity,
  );
}

export function htmlToPlainText(value) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\s*li\b[^>]*>/gi, '\n- ')
    .replace(
      /<\/\s*(p|div|li|h[1-6]|section|article|tr|ul|ol)\s*>/gi,
      '\n',
    )
    .replace(/<[^>]+>/g, ' ')
    .replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, decodeEntity)
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
