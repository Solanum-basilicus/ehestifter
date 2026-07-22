function boundedInteger(value, fallback, minimum, maximum) {
  return Number.isInteger(value)
    ? Math.min(maximum, Math.max(minimum, value))
    : fallback;
}

function safeWrite(stream, value) {
  try {
    stream.write(value);
  } catch {
    /* Progress is diagnostic and must never affect scanner correctness. */
  }
}

function compactText(value, maximum) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (text.length <= maximum) return text;
  return `${text.slice(0, Math.max(0, maximum - 1))}…`;
}

export function createProgressRenderer({
  stream = process.stderr,
  enabled = 'auto',
  monotonicNow = () => Date.now(),
  minimumIntervalMs = 80,
} = {}) {
  const active = enabled === true
    || (enabled === 'auto' && stream?.isTTY === true);
  let lastRenderedAt = Number.NEGATIVE_INFINITY;
  let lastStage = null;
  let visible = false;

  function update({ stage, current = 0, total = 0, detail = '' }) {
    if (!active) return;
    const normalizedTotal = Math.max(0, Number(total) || 0);
    const normalizedCurrent = Math.min(
      normalizedTotal,
      Math.max(0, Number(current) || 0),
    );
    const now = monotonicNow();
    const force = stage !== lastStage
      || normalizedCurrent === 0
      || normalizedCurrent === normalizedTotal;
    if (!force && now - lastRenderedAt < minimumIntervalMs) return;

    const columns = boundedInteger(stream.columns, 100, 40, 240);
    const barWidth = boundedInteger(Math.floor(columns * 0.2), 20, 10, 36);
    const ratio = normalizedTotal === 0
      ? 0
      : normalizedCurrent / normalizedTotal;
    const filled = Math.round(ratio * barWidth);
    const bar = `${'█'.repeat(filled)}${'░'.repeat(barWidth - filled)}`;
    const percent = normalizedTotal === 0
      ? '  0'
      : String(Math.floor(ratio * 100)).padStart(3, ' ');
    const prefix = `[${bar}] ${percent}% ${compactText(stage, 18)} `
      + `${normalizedCurrent}/${normalizedTotal}`;
    const remaining = Math.max(0, columns - prefix.length - 2);
    const suffix = detail ? ` ${compactText(detail, remaining)}` : '';

    safeWrite(stream, `\r\x1b[2K${prefix}${suffix}`);
    visible = true;
    lastStage = stage;
    lastRenderedAt = now;
  }

  function clear() {
    if (!active || !visible) return;
    safeWrite(stream, '\r\x1b[2K');
    visible = false;
  }

  return {
    enabled: active,
    update,
    clear,
  };
}
