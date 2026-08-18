const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

global.window = {};
require(path.join(__dirname, '..', 'static', 'js', 'status-utils.js'));

const Status = global.window.Status;

test('suggestNext selects Screening Booked after Applied', () => {
  assert.equal(Status.suggestNext('Applied'), 'Screening Booked');
});

test('suggestNext selects Ignored after rejection', () => {
  assert.equal(Status.suggestNext('Rejected with Unfortunately'), 'Ignored');
});

test('suggestNext selects the canonical done status after more interviews are booked', () => {
  assert.equal(Status.suggestNext('More interviews Booked'), 'More interviews Done');
});

test('quick actions for an unset status are Applied and Ignored', () => {
  assert.deepEqual(Status.suggestQuickActions('Unset'), ['Applied', 'Ignored']);
  assert.deepEqual(Status.suggestQuickActions(null), ['Applied', 'Ignored']);
});

test('quick actions after rejection are Ignored and Applied', () => {
  assert.deepEqual(
    Status.suggestQuickActions('Rejected with Unfortunately'),
    ['Ignored', 'Applied']
  );
});

test('quick actions use rejection as the normal secondary action', () => {
  assert.deepEqual(
    Status.suggestQuickActions('Applied'),
    ['Screening Booked', 'Rejected with Unfortunately']
  );
});

test('quick actions are distinct canonical status options for every current status', () => {
  const currentStates = [null, 'Unset', ...Status.STATUS_OPTIONS];

  for (const state of currentStates) {
    const suggestions = Status.suggestQuickActions(state);
    assert.equal(new Set(suggestions).size, suggestions.length, `${state} must have distinct quick actions`);

    for (const suggestion of suggestions) {
      assert.ok(
        Status.STATUS_OPTIONS.includes(suggestion),
        `${suggestion} must be a canonical status`
      );
    }
  }
});
