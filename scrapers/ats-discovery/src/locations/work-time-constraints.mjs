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
    || /\b(?:available|availability|active|online|overlap|schedule|timezone|time\s+zone)\b/iu.test(text)
    || /\b(?:time|timezone)\s+hours?\b/iu.test(text);
}

function strength(text) {
  if (/\b(?:must|required|mandatory|need(?:ed)?|expected|at\s+least)\b/iu.test(text)) {
    return 'required';
  }
  if (/\b(?:preferred|ideally|nice\s+to\s+have)\b/iu.test(text)) return 'preferred';
  return 'stated';
}


const V2_TERM_RANGES = Object.freeze([
  ['Pacific Time', -480, -420], ['Pacific timezone', -480, -420], ['PST', -480, -480], ['PDT', -420, -420], ['PT', -480, -420],
  ['Mountain Time', -420, -360], ['Mountain timezone', -420, -360], ['MST', -420, -420], ['MDT', -360, -360], ['MT', -420, -360],
  ['Eastern Time', -300, -240], ['Eastern timezone', -300, -240], ['EST', -300, -300], ['EDT', -240, -240], ['ET', -300, -240],
  ['Central Time', -360, -300], ['Central timezone', -360, -300], ['CDT', -300, -300],
  ['Central European Time', 60, 120], ['CET', 60, 120], ['CEST', 120, 120],
  ['Western European Time', 0, 60], ['Greenwich Mean Time', 0, 0], ['GMT', 0, 0], ['British Summer Time', 60, 60],
  ['Gulf Standard Time', 240, 240], ['Arabia Standard Time', 180, 180], ['India Standard Time', 330, 330],
  ['China Standard Time', 480, 480], ['Singapore Time', 480, 480], ['Hong Kong Time', 480, 480], ['Korea Standard Time', 540, 540],
  ['Japan Standard Time', 540, 540], ['JST', 540, 540], ['Australian Eastern Time', 600, 660], ['AEST', 600, 600], ['AEDT', 660, 660],
]);

function v2Ranges(observations) {
  const ranges = new Map();
  for (const observation of observations) {
    if (observation.strength === 'preferred') continue;
    for (const term of observation.matchedTerms) {
      const entry = V2_TERM_RANGES.find(([name]) => name === term);
      if (!entry) continue;
      const [, start, end] = entry;
      ranges.set(`${start}:${end}`, {
        offsetRangeStartMinutes: start,
        offsetRangeEndMinutes: end,
      });
    }
  }
  return [...ranges.values()].sort((left, right) => (
    left.offsetRangeStartMinutes - right.offsetRangeStartMinutes
    || left.offsetRangeEndMinutes - right.offsetRangeEndMinutes
  ));
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
    rangesV2: v2Ranges(observations),
  };
}
