const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

global.window = {};
require(path.join(__dirname, '..', 'static', 'js', 'score-threshold.js'));
const score = global.window.ScoreThreshold;

function makeStorage() {
  const map = new Map();
  return {
    getItem: (key) => map.has(key) ? map.get(key) : null,
    setItem: (key, value) => map.set(key, value),
  };
}

test('a new browser tab reads the last confirmed score', () => {
  const storage = makeStorage();
  assert.equal(score.read(storage), 5);
  assert.equal(score.save(storage, 7.5), true);
  assert.equal(score.read(storage), 7.5);
  assert.equal(storage.getItem(score.STORAGE_KEY), '7.5');
});

test('the highest allowed threshold is below ten', () => {
  assert.equal(score.validScore(9.5), 9.5);
  assert.equal(score.validScore(10), null);
  assert.equal(score.validScore(4.25), null);
  assert.equal(score.validScore(-0.5), null);
  assert.equal(score.validScore('bad'), null);
  assert.equal(score.validScore(''), null);
  assert.equal(score.validScore(true), null);
});

test('invalid saved data and blocked storage use the default', () => {
  const storage = makeStorage();
  storage.setItem(score.STORAGE_KEY, 'Infinity');
  assert.equal(score.read(storage), 5);
  assert.equal(score.save(storage, 6.25), false);
  const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); } };
  assert.equal(score.read(blocked), 5);
  assert.equal(score.save(blocked, 7), false);
});
