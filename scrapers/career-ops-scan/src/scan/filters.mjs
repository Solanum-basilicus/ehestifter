// Portions derived from santifer/career-ops scan.mjs.
// Originally distributed under the MIT License.
// Modified for Ehestifter. See THIRD_PARTY_NOTICES.md.

function normalizeKeywordList(value) {
  if (value == null) return [];
  const values = Array.isArray(value) ? value : [value];
  return values
    .filter((item) => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);
}

export function compileKeyword(keyword) {
  if (/^[a-z]{2,3}$/.test(keyword)) {
    const expression = new RegExp(`\\b${keyword}\\b`);
    return (lower) => expression.test(lower);
  }
  return (lower) => lower.includes(keyword);
}

export function buildTitleFilter(config) {
  const compile = (value) => normalizeKeywordList(value).map(compileKeyword);
  const positive = compile(config?.positive);
  const negative = compile(config?.negative);

  return (title) => {
    const lower = String(title ?? '').toLowerCase();
    return (positive.length === 0 || positive.some((matcher) => matcher(lower)))
      && !negative.some((matcher) => matcher(lower));
  };
}

export function matchedTitleKeywords(title, config) {
  const lower = String(title ?? '').toLowerCase();
  return (Array.isArray(config?.positive) ? config.positive : [])
    .filter((keyword) => typeof keyword === 'string' && keyword.trim())
    .filter((keyword) => compileKeyword(keyword.trim().toLowerCase())(lower));
}

export function buildLocationFilter(config) {
  if (!config) return () => true;
  const alwaysAllow = normalizeKeywordList(config.always_allow);
  const allow = normalizeKeywordList(config.allow);
  const block = normalizeKeywordList(config.block);

  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.some((keyword) => lower.includes(keyword))) return true;
    if (block.some((keyword) => lower.includes(keyword))) return false;
    return allow.length === 0 || allow.some((keyword) => lower.includes(keyword));
  };
}

export function buildPostingAgeFilter(maxAgeDays, now = Date.now()) {
  const max = Number(maxAgeDays);
  if (!Number.isInteger(max) || max <= 0) return () => true;
  const cutoff = now - max * 86_400_000;
  return (postedAt) => typeof postedAt !== 'number'
    || !Number.isFinite(postedAt)
    || postedAt >= cutoff;
}

export function buildSalaryFilter(config) {
  if (!config) return () => true;
  const min = Number(config.min ?? 0);
  const max = Number(config.max ?? 0);
  const currency = String(config.currency ?? '').trim().toUpperCase();

  if (!Number.isFinite(min) || !Number.isFinite(max) || min < 0 || max < 0) {
    throw new Error('salary_filter min/max must be non-negative numbers');
  }
  if (max > 0 && min > max) {
    throw new Error('salary_filter min cannot exceed max');
  }

  return (salary) => {
    if (!salary || (min === 0 && max === 0)) return true;
    const jobMin = salary.min ?? salary.max ?? null;
    const jobMax = salary.max ?? salary.min ?? null;
    const jobCurrency = String(salary.currency ?? '').trim().toUpperCase();
    if (jobMin == null && jobMax == null) return true;
    if (currency && jobCurrency && currency !== jobCurrency) return false;
    if (min > 0 && jobMax != null && jobMax < min) return false;
    if (max > 0 && jobMin != null && jobMin > max) return false;
    return true;
  };
}

export function buildContentFilter(config) {
  if (!config) return () => true;
  const globalPositive = normalizeKeywordList(config.positive);
  const globalNegative = normalizeKeywordList(config.negative);
  const overrides = new Map();

  if (config.by_title_keyword && typeof config.by_title_keyword === 'object') {
    for (const [keyword, rule] of Object.entries(config.by_title_keyword)) {
      if (!keyword.trim()) continue;
      overrides.set(keyword.trim().toLowerCase(), {
        positive: normalizeKeywordList(rule?.positive),
        negative: normalizeKeywordList(rule?.negative),
      });
    }
  }

  const passes = (lower, rule) => {
    if (rule.negative.some((keyword) => lower.includes(keyword))) return false;
    return rule.positive.length === 0
      || rule.positive.some((keyword) => lower.includes(keyword));
  };

  return (description, matchedKeywords = []) => {
    if (typeof description !== 'string' || description.trim() === '') return true;
    const lower = description.toLowerCase();
    const matchingOverrides = matchedKeywords
      .map((keyword) => overrides.get(String(keyword).trim().toLowerCase()))
      .filter(Boolean);
    if (matchingOverrides.length > 0) {
      return matchingOverrides.some((rule) => passes(lower, rule));
    }
    return passes(lower, { positive: globalPositive, negative: globalNegative });
  };
}
