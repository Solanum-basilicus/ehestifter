const COUNTRY_BY_ALIAS = new Map([
  [
    'germany',
    {
      countryName: 'Germany',
      countryCode: 'DE',
    },
  ],
  [
    'deutschland',
    {
      countryName: 'Germany',
      countryCode: 'DE',
    },
  ],
]);

const NON_CITY_VALUES = new Set([
  'remote',
  'hybrid',
  'on-site',
  'onsite',
  'office',
  'home office',
  'worldwide',
  'anywhere',
]);

function cleanText(value) {
  return typeof value === 'string'
    ? value.replace(/\s+/g, ' ').trim()
    : '';
}

function countryFromAlias(value) {
  return COUNTRY_BY_ALIAS.get(
    cleanText(value).toLocaleLowerCase('en'),
  ) ?? null;
}

function containsMultipleLocationSyntax(value) {
  return (
    /[·;|\n]/.test(value)
    || /\s+\bor\b\s+/i.test(value)
    || /\s+\/\s+/.test(value)
  );
}

function validCityName(value) {
  const city = cleanText(value);

  if (city === '') {
    return false;
  }

  if (
    NON_CITY_VALUES.has(
      city.toLocaleLowerCase('en'),
    )
  ) {
    return false;
  }

  /*
   * Conservative Unicode city-name syntax:
   * letters, combining marks, spaces, periods,
   * apostrophes and hyphens.
   */
  return /^[\p{L}\p{M}][\p{L}\p{M} .'\-]{0,99}$/u.test(
    city,
  );
}

export function normalizeRawLocation(rawLocation) {
  const raw = cleanText(rawLocation);

  if (raw === '') {
    return {
      status: 'missing',
      locations: [],
    };
  }

  if (containsMultipleLocationSyntax(raw)) {
    return {
      status: 'unparsed_multiple',
      locations: [],
    };
  }

  const parts = raw
    .split(',')
    .map(cleanText)
    .filter(Boolean);

  /*
   * Exact country-only location.
   */
  if (parts.length === 1) {
    const country = countryFromAlias(parts[0]);

    if (!country) {
      return {
        status: 'unparsed_single_value',
        locations: [],
      };
    }

    return {
      status: 'normalized_country',
      locations: [
        {
          ...country,
          cityName: null,
          region: null,
        },
      ],
    };
  }

  /*
   * Only accept an exact "City, Country" pair.
   */
  if (parts.length !== 2) {
    return {
      status: 'unparsed_parts',
      locations: [],
    };
  }

  const [firstPart, countryPart] = parts;
  const country = countryFromAlias(countryPart);

  if (!country) {
    return {
      status: 'unparsed_country',
      locations: [],
    };
  }

  const firstNormalized =
    firstPart.toLocaleLowerCase('en');

  /*
   * "Remote, Germany" describes country scope,
   * not a city named Remote.
   */
  if (NON_CITY_VALUES.has(firstNormalized)) {
    return {
      status: 'normalized_country_scope',
      locations: [
        {
          ...country,
          cityName: null,
          region: null,
        },
      ],
    };
  }

  if (!validCityName(firstPart)) {
    return {
      status: 'unparsed_city',
      locations: [],
    };
  }

  return {
    status: 'normalized_city_country',
    locations: [
      {
        ...country,
        cityName: firstPart,
        region: null,
      },
    ],
  };
}

export function normalizeCandidateLocations(
  candidates,
) {
  return candidates.map((candidate) => {
    if (
      Array.isArray(candidate.locations)
      && candidate.locations.length > 0
    ) {
      return {
        ...candidate,
        locationNormalization: {
          status: 'provider_structured',
          rawLocation:
            cleanText(candidate.rawLocation)
            || null,
        },
      };
    }

    const result = normalizeRawLocation(
      candidate.rawLocation,
    );

    return {
      ...candidate,
      locations: result.locations,
      locationNormalization: {
        status: result.status,
        rawLocation:
          cleanText(candidate.rawLocation)
          || null,
      },
    };
  });
}
