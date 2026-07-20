export function usageText() {
  return `Usage:
  node src/cli.mjs catalog sync ashby
  node src/cli.mjs scan tracked --offline
  node src/cli.mjs scan tracked --preflight
  node src/cli.mjs scan tracked --import --max-create N
`;
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

  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (['--offline', '--preflight', '--import'].includes(flag)) {
      if (mode !== null) throw new Error('Choose exactly one mode');
      mode = flag.slice(2);
      continue;
    }

    if (flag === '--max-create') {
      const rawValue = flags[index + 1];
      const value = Number.parseInt(rawValue, 10);
      if (
        !rawValue
        || !Number.isInteger(value)
        || value <= 0
        || String(value) !== rawValue
      ) {
        throw new Error('--max-create requires a positive integer');
      }
      maxCreate = value;
      index += 1;
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

  return {
    command: 'scan',
    source: 'tracked',
    mode,
    maxCreate,
  };
}
