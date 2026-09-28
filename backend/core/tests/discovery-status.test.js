const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

global.window = {};
require(path.join(__dirname, '..', 'static', 'js', 'discovery-status.js'));

const DiscoveryStatus = global.window.DiscoveryStatus;

test('enabled status has no remediation action', () => {
  assert.deepEqual(
    DiscoveryStatus.buildView({ enabled: true, reasons: [] }),
    { state: 'enabled', label: 'Enabled', actions: [] },
  );
});

test('CV and positive-title blockers point to the matching profile sections', () => {
  const view = DiscoveryStatus.buildView({
    enabled: false,
    reasons: ['no_usable_cv', 'no_positive_title'],
  });
  assert.equal(view.label, 'Disabled');
  assert.deepEqual(view.actions, [
    { label: 'add CV content', href: '#prefs' },
    { label: 'add at least one positive title rule', href: '#discovery-prefs' },
  ]);
});

test('invalid preferences point to discovery preferences', () => {
  const view = DiscoveryStatus.buildView({
    enabled: false,
    reasons: ['invalid_preferences'],
  });
  assert.deepEqual(view.actions, [
    { label: 'fix discovery preferences', href: '#discovery-prefs' },
  ]);
});

test('missing status is unavailable instead of guessed', () => {
  assert.deepEqual(
    DiscoveryStatus.buildView(null),
    { state: 'unavailable', label: 'Unavailable', actions: [] },
  );
});
