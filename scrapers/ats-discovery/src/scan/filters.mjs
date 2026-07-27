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

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a configured keyword as a word/phrase matcher.
 *
 * Raw substring matching made `Intern` reject `International` and made short
 * tokens such as `US` match ordinary words. A phrase may still span spaces,
 * punctuation, slashes, or hyphens, but its ends must be Unicode
 * letter/number boundaries.
 */
export function compileKeyword(keyword) {
  const normalized = String(keyword ?? '').trim().toLowerCase();
  const tokens = normalized.match(/[\p{L}\p{N}]+/gu) ?? [];
  if (tokens.length === 0) return () => false;
  const body = tokens.map(escapeRegExp).join('[^\\p{L}\\p{N}]+');
  const expression = new RegExp(
    `(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`,
    'u',
  );
  return (lower) => expression.test(lower);
}

function compiledKeywordEntries(value) {
  return normalizeKeywordList(value).map((keyword) => ({
    keyword,
    matcher: compileKeyword(keyword),
  }));
}

export function buildTitleEvaluator(config) {
  const positive = compiledKeywordEntries(config?.positive);
  const negative = compiledKeywordEntries(config?.negative);
  return (title) => {
    const lower = String(title ?? '').toLowerCase();
    const positiveMatches = positive
      .filter((entry) => entry.matcher(lower))
      .map((entry) => entry.keyword);
    const negativeMatches = negative
      .filter((entry) => entry.matcher(lower))
      .map((entry) => entry.keyword);
    return {
      allowed: (positive.length === 0 || positiveMatches.length > 0)
        && negativeMatches.length === 0,
      positiveMatches,
      negativeMatches,
    };
  };
}

export function buildTitleFilter(config) {
  const evaluate = buildTitleEvaluator(config);
  return (title) => evaluate(title).allowed;
}

export function matchedTitleKeywords(title, config) {
  const lower = String(title ?? '').toLowerCase();
  return (Array.isArray(config?.positive) ? config.positive : [])
    .filter((keyword) => typeof keyword === 'string' && keyword.trim())
    .filter((keyword) => compileKeyword(keyword)(lower));
}

export function buildLocationFilter(config) {
  if (!config) return () => true;
  const compile = (value) => normalizeKeywordList(value).map(compileKeyword);
  const alwaysAllow = compile(config.always_allow);
  const allow = compile(config.allow);
  const block = compile(config.block);
  return (location) => {
    if (typeof location !== 'string' || location.trim() === '') return true;
    const lower = location.toLowerCase();
    if (alwaysAllow.some((matcher) => matcher(lower))) return true;
    if (block.some((matcher) => matcher(lower))) return false;
    return allow.length === 0 || allow.some((matcher) => matcher(lower));
  };
}

export function buildPostingAgeFilter(maxAgeDays, now = Date.now()) {
  const max = Number(maxAgeDays);
  if (!Number.isInteger(max) || max <= 0) return () => true;
  const cutoff = now - max * 86_400_000;
  return (postedAt) => (
    typeof postedAt !== 'number'
    || !Number.isFinite(postedAt)
    || postedAt >= cutoff
  );
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
    return passes(lower, {
      positive: globalPositive,
      negative: globalNegative,
    });
  };
}
