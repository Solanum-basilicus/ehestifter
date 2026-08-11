function pushRecord(records, record, field, { hadDelimiter }) {
  record.push(field);
  if (record.length === 1 && record[0] === '' && !hadDelimiter) return;
  records.push(record);
}

export function parseStrictCsv(text, { expectedHeader = null, label = 'CSV' } = {}) {
  if (typeof text !== 'string') throw new Error(`${label} input must be a string`);
  const source = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
  const records = [];
  let record = [];
  let field = '';
  let inQuotes = false;
  let afterQuote = false;
  let hadDelimiter = false;
  let line = 1;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];

    if (inQuotes) {
      if (char === '"') {
        if (source[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
          afterQuote = true;
        }
      } else {
        field += char;
        if (char === '\n') line += 1;
      }
      continue;
    }

    if (afterQuote) {
      if (char === ',') {
        record.push(field);
        field = '';
        afterQuote = false;
        hadDelimiter = true;
        continue;
      }
      if (char === '\r' || char === '\n') {
        pushRecord(records, record, field, { hadDelimiter });
        record = [];
        field = '';
        afterQuote = false;
        hadDelimiter = false;
        if (char === '\r' && source[index + 1] === '\n') index += 1;
        line += 1;
        continue;
      }
      throw new Error(`${label} has unexpected character after closing quote on line ${line}`);
    }

    if (char === '"') {
      if (field !== '') {
        throw new Error(`${label} has an unexpected quote in an unquoted field on line ${line}`);
      }
      inQuotes = true;
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      hadDelimiter = true;
      continue;
    }
    if (char === '\r' || char === '\n') {
      pushRecord(records, record, field, { hadDelimiter });
      record = [];
      field = '';
      hadDelimiter = false;
      if (char === '\r' && source[index + 1] === '\n') index += 1;
      line += 1;
      continue;
    }
    field += char;
  }

  if (inQuotes) throw new Error(`${label} has an unterminated quoted field`);
  if (record.length > 0 || field !== '' || hadDelimiter || afterQuote) {
    pushRecord(records, record, field, { hadDelimiter });
  }

  if (records.length === 0) throw new Error(`${label} contains no rows`);
  if (expectedHeader != null) {
    if (!Array.isArray(expectedHeader) || expectedHeader.some((value) => typeof value !== 'string')) {
      throw new Error('expectedHeader must be an array of strings');
    }
    const header = records[0];
    if (
      header.length !== expectedHeader.length
      || header.some((value, index) => value !== expectedHeader[index])
    ) {
      throw new Error(`${label} header must be exactly: ${expectedHeader.join(',')}`);
    }
  }
  return records;
}
