export function usageText() {
  return `Usage:
  node src/cli.mjs catalog sync ashby
  node src/cli.mjs scan tracked --offline [--no-progress]
  node src/cli.mjs scan tracked --preflight [--catalog-targets N] [--no-progress]
  node src/cli.mjs scan tracked --import --max-create N [--catalog-targets N] [--no-progress]
`;
}

function parsePositiveInteger(rawValue, flag) {
  const value = Number.parseInt(rawValue, 10);
  if (
    !rawValue
    || !Number.isInteger(value)
    || value <= 0
    || String(value) !== rawValue
  ) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return value;
}

export function parseArgs(argv) {
  if (!Array.isArray(argv)) {
    throw new Error('argv must be an array');
  }
  if (argv.includes('--help') || argv.includes('-h')) {
    return { command: 'help' };
  }

  const [command, subject, providerOrFlag, ...rest] = argv;

  if (command === 'catalog') {
    if (
      subject !== 'sync'
      || providerOrFlag !== 'ashby'
      || rest.length > 0
    ) {
      throw new Error('Only "catalog sync ashby" is implemented');
    }
    return {
      command: 'catalog-sync',
      provider: 'ashby',
    };
  }

  if (command !== 'scan' || subject !== 'tracked') {
    throw new Error('Expected "scan tracked" or "catalog sync ashby"');
  }

  const flags = [providerOrFlag, ...rest].filter((value) => value != null);
  let mode = null;
  let maxCreate = null;
  let catalogTargets = null;
  let noProgress = false;

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (['--offline', '--preflight', '--import'].includes(flag)) {
      if (mode !== null) throw new Error('Choose exactly one mode');
      mode = flag.slice(2);
      continue;
    }

    if (flag === '--max-create') {
      maxCreate = parsePositiveInteger(flags[index + 1], '--max-create');
      index += 1;
      continue;
    }

    if (flag === '--catalog-targets') {
      catalogTargets = parsePositiveInteger(
        flags[index + 1],
        '--catalog-targets',
      );
      index += 1;
      continue;
    }

    if (flag === '--no-progress') {
      if (noProgress) throw new Error('--no-progress may be supplied only once');
      noProgress = true;
      continue;
    }

    throw new Error(`Unknown argument: ${flag}`);
  }

  if (mode === null) {
    throw new Error('Choose one of --offline, --preflight, or --import');
  }
  if (mode === 'import' && maxCreate === null) {
    throw new Error('Import mode requires --max-create N');
  }
  if (mode !== 'import' && maxCreate !== null) {
    throw new Error('--max-create is valid only with --import');
  }
  if (mode === 'offline' && catalogTargets !== null) {
    throw new Error(
      '--catalog-targets is valid only with --preflight or --import; '
      + 'offline target count comes from discovery policy',
    );
  }

  return {
    command: 'scan',
    source: 'tracked',
    mode,
    maxCreate,
    catalogTargets,
    noProgress,
  };
}
