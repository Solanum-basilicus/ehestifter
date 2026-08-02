const REGIONS = Object.freeze([
  {
    id: 'north_america_west',
    label: 'North America West',
    terms: [
      'Pacific Time', 'Pacific timezone', 'Mountain Time', 'Mountain timezone',
      'PST', 'PDT', 'MST', 'MDT', 'PT', 'MT',
    ],
  },
  {
    id: 'north_america_east',
    label: 'North America East',
    terms: [
      'Eastern Time', 'Eastern timezone', 'Central Time', 'Central timezone',
      'EST', 'EDT', 'CST', 'CDT', 'ET', 'CT',
    ],
  },
  {
    id: 'europe',
    label: 'Europe',
    terms: [
      'Central European Time', 'Western European Time', 'Greenwich Mean Time',
      'British Summer Time', 'CET', 'CEST', 'GMT', 'BST',
      'European working hours', 'Europe hours',
    ],
  },
  {
    id: 'west_asia',
    label: 'West Asia',
    terms: ['Gulf Standard Time', 'Arabia Standard Time', 'India Standard Time'],
  },
  {
    id: 'east_asia',
    label: 'East Asia',
    terms: ['China Standard Time', 'Singapore Time', 'Hong Kong Time', 'Korea Standard Time'],
  },
  {
    id: 'australia_japan',
    label: 'Australia/Japan',
    terms: ['Japan Standard Time', 'JST', 'Australian Eastern Time', 'AEST', 'AEDT'],
  },
]);

function cleanText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/gu, ' ').trim()
    : '';
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function termRegex(term) {
  const expression = cleanText(term)
    .split(/\s+/u)
    .map(escapeRegex)
    .join('[\\s.-]+');
  return new RegExp(`(?<![\\p{L}\\p{N}])${expression}(?![\\p{L}\\p{N}])`, 'iu');
}

function windows(description) {
  if (typeof description !== 'string' || description.trim() === '') return [];
  return description
    .replace(/<br\s*\/?\s*>/giu, '\n')
    .replace(/<\/(?:p|li|div|section|article|h[1-6])\s*>/giu, '\n')
    .replace(/<[^>]+>/gu, ' ')
    .replace(/\r\n?/gu, '\n')
    .split(/(?:\n+|(?<=[.!?;])\s+)/u)
    .map(cleanText)
    .filter((item) => item.length >= 4)
    .map((item) => item.slice(0, 500));
}

function scheduleContext(text) {
  return /\b(?:work|working|business|office|team|core)\s+hours?\b/iu.test(text)
    || /\b(?:available|availability|active|online|overlap|schedule|timezone|time\s+zone)\b/iu.test(text);
}

function strength(text) {
  if (/\b(?:must|required|mandatory|need(?:ed)?|expected|at\s+least)\b/iu.test(text)) {
    return 'required';
  }
  if (/\b(?:preferred|ideally|nice\s+to\s+have)\b/iu.test(text)) return 'preferred';
  return 'stated';
}

export function extractWorkTimeConstraints(description) {
  const observations = [];
  for (const text of windows(description)) {
    if (!scheduleContext(text)) continue;
    for (const region of REGIONS) {
      const matchedTerms = region.terms.filter((term) => termRegex(term).test(text));
      if (matchedTerms.length === 0) continue;
      observations.push({
        source: 'description',
        kind: 'work_time_region',
        status: 'resolved',
        region: region.id,
        label: region.label,
        strength: strength(text),
        matchedTerms,
        text,
      });
    }
  }

  const regions = [...new Set(observations.map((item) => item.region))];
  return {
    schemaVersion: 1,
    status: regions.length === 0
      ? 'none'
      : regions.length === 1
        ? 'resolved'
        : 'multiple',
    regions,
    observations,
  };
}
