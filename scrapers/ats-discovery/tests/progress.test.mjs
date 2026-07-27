import test from 'node:test';
import assert from 'node:assert/strict';

import { createProgressRenderer } from '../src/ui/progress.mjs';

function stream({ isTTY = true, columns = 80, throwOnWrite = false } = {}) {
  let output = '';
  return {
    isTTY,
    columns,
    write(value) {
      if (throwOnWrite) throw new Error('broken stream');
      output += value;
    },
    output: () => output,
  };
}

test('TTY progress overwrites one line with carriage return and clear-line ANSI', () => {
  const target = stream();
  let now = 0;
  const progress = createProgressRenderer({
    stream: target,
    monotonicNow: () => now,
    minimumIntervalMs: 0,
  });
  progress.update({ stage: 'scan', current: 0, total: 10 });
  now += 1;
  progress.update({ stage: 'scan', current: 5, total: 10, detail: 'ashby:n8n' });
  now += 1;
  progress.update({ stage: 'scan', current: 10, total: 10 });
  progress.clear();

  assert.match(target.output(), /\r\x1b\[2K/);
  assert.match(target.output(), /50% scan 5\/10 ashby:n8n/);
  assert.equal(target.output().includes('\n'), false);
  assert.ok(target.output().endsWith('\r\x1b[2K'));
});

test('non-TTY progress is silent in auto mode', () => {
  const target = stream({ isTTY: false });
  const progress = createProgressRenderer({ stream: target });
  progress.update({ stage: 'scan', current: 1, total: 2 });
  progress.clear();
  assert.equal(target.output(), '');
  assert.equal(progress.enabled, false);
});

test('explicit disable overrides a TTY', () => {
  const target = stream({ isTTY: true });
  const progress = createProgressRenderer({ stream: target, enabled: false });
  progress.update({ stage: 'scan', current: 1, total: 1 });
  assert.equal(target.output(), '');
});

test('progress throttles intermediate updates but never stage changes or completion', () => {
  const target = stream();
  let now = 0;
  const progress = createProgressRenderer({
    stream: target,
    monotonicNow: () => now,
    minimumIntervalMs: 100,
  });
  progress.update({ stage: 'scan', current: 0, total: 10 });
  now = 10;
  progress.update({ stage: 'scan', current: 1, total: 10 });
  now = 20;
  progress.update({ stage: 'preflight', current: 0, total: 3 });
  now = 30;
  progress.update({ stage: 'preflight', current: 3, total: 3 });

  assert.equal((target.output().match(/\x1b\[2K/g) ?? []).length, 3);
  assert.equal(target.output().includes('scan 1/10'), false);
  assert.match(target.output(), /preflight 3\/3/);
});

test('progress truncates long details to terminal width', () => {
  const target = stream({ columns: 40 });
  const progress = createProgressRenderer({ stream: target, minimumIntervalMs: 0 });
  progress.update({
    stage: 'scan',
    current: 1,
    total: 2,
    detail: 'a'.repeat(200),
  });
  const rendered = target.output().split('\x1b[2K').at(-1);
  assert.ok(rendered.length <= 42);
});

test('broken progress stream never affects scanner work', () => {
  const target = stream({ throwOnWrite: true });
  const progress = createProgressRenderer({ stream: target, enabled: true });
  assert.doesNotThrow(() => {
    progress.update({ stage: 'scan', current: 1, total: 1 });
    progress.clear();
  });
});
