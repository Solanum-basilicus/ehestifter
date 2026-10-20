(function (root) {
  'use strict';

  const STORAGE_KEY = 'jobs.openMinCompatibilityScore';
  const DEFAULT = 5.0;

  function validScore(value) {
    if (value === null || value === undefined || !['string', 'number'].includes(typeof value) || String(value).trim() === '') return null;
    const score = Number(value);
    if (!Number.isFinite(score) || score < 0 || score > 9.5 || score * 2 !== Math.round(score * 2)) return null;
    return score;
  }

  function read(storage) {
    try {
      const score = validScore(storage.getItem(STORAGE_KEY));
      return score === null ? DEFAULT : score;
    } catch (_) {
      return DEFAULT;
    }
  }

  function save(storage, score) {
    const valid = validScore(score);
    if (valid === null) return false;
    try {
      storage.setItem(STORAGE_KEY, valid.toFixed(1));
      return true;
    } catch (_) {
      return false;
    }
  }

  root.ScoreThreshold = { STORAGE_KEY, DEFAULT, validScore, read, save };
})(typeof window !== 'undefined' ? window : globalThis);
