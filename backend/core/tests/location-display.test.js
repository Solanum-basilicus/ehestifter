const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

global.window = {};
require(path.join(__dirname, '..', 'static', 'js', 'location-display.js'));

const LocationDisplay = global.window.LocationDisplay;

function v2City(name, region, country) {
  return {
    kind: 'city',
    locationId: `test:${country}:${region}:${name}`,
    displayName: name,
    adminRegionName: region,
    countryName: country,
  };
}

test('summary groups cities by country', () => {
  const view = LocationDisplay.buildPresentation({
    locationModel: 'v2',
    maxSymbols: 200,
    locationsV2: [
      v2City('Zwickau', 'Saxony', 'Germany'),
      v2City('Freising', 'Bavaria', 'Germany'),
      v2City('Assen', 'Drenthe', 'Netherlands'),
    ],
  });

  assert.equal(view.summaryText, 'Germany: Freising, Zwickau; Netherlands: Assen');
  assert.equal(view.hiddenCount, 0);
  assert.equal(view.totalCount, 3);
});

test('summary adds a region only for duplicate city names in one country', () => {
  const view = LocationDisplay.buildPresentation({
    locationModel: 'v2',
    maxSymbols: 200,
    locationsV2: [
      v2City('Springfield', 'Oregon', 'United States'),
      v2City('Springfield', 'Illinois', 'United States'),
    ],
  });

  assert.equal(
    view.summaryText,
    'United States: Springfield (Illinois), Springfield (Oregon)',
  );
});

test('summary stays within the symbol limit and counts hidden locations', () => {
  const locationsV2 = [
    v2City('Aachen', 'North Rhine-Westphalia', 'Germany'),
    v2City('Albstadt', 'Baden-Wurttemberg', 'Germany'),
    v2City('Anklam', 'Mecklenburg-Vorpommern', 'Germany'),
    v2City('Assen', 'Drenthe', 'Netherlands'),
    v2City('Aarau', 'Aargau', 'Switzerland'),
    v2City('Zürich', 'Zurich', 'Switzerland'),
  ];

  const view = LocationDisplay.buildPresentation({ locationModel: 'v2', locationsV2, maxSymbols: 70 });

  assert.ok(LocationDisplay.symbolCount(view.summaryText) <= 70);
  assert.equal(view.totalCount, 6);
  assert.equal(view.hiddenCount, 2);
  assert.equal(view.summaryText, 'Germany: Aachen, Albstadt, Anklam; Netherlands: Assen … +2');
});

test('summary counts visible Unicode characters as symbols', () => {
  assert.equal(LocationDisplay.symbolCount('Zürich · Baden-Württemberg'), 26);
  assert.equal(LocationDisplay.symbolCount('e\u0301'), 1);
});

test('tree groups cities under regions and countries', () => {
  const view = LocationDisplay.buildPresentation({
    locationModel: 'v2',
    maxSymbols: 200,
    locationsV2: [
      v2City('Zwickau', 'Saxony', 'Germany'),
      v2City('Schkeuditz', 'Saxony', 'Germany'),
      v2City('Freising', 'Bavaria', 'Germany'),
      v2City('Assen', 'Drenthe', 'Netherlands'),
    ],
  });

  assert.equal(
    view.treeText,
    [
      'Germany',
      '  Bavaria: Freising',
      '  Saxony: Schkeuditz, Zwickau',
      'Netherlands',
      '  Drenthe: Assen',
    ].join('\n'),
  );
});

test('tree keeps direct country and region locations', () => {
  const view = LocationDisplay.buildPresentation({
    locationModel: 'v2',
    maxSymbols: 200,
    locationsV2: [
      { kind: 'country', locationId: 'iso3166:DE', displayName: 'Germany', countryName: 'Germany' },
      { kind: 'adminRegion', locationId: 'test:bavaria', displayName: 'Bavaria', adminRegionName: 'Bavaria', countryName: 'Germany' },
      v2City('Freising', 'Bavaria', 'Germany'),
    ],
  });

  assert.equal(view.summaryText, 'Germany: Bavaria, Freising');
  assert.equal(view.treeText, 'Germany\n  Bavaria: Freising');
  assert.equal(view.totalCount, 3);
});

test('long first location falls back to its country without cutting a name', () => {
  const view = LocationDisplay.buildPresentation({
    locationModel: 'v2',
    maxSymbols: 30,
    locationsV2: [
      v2City('A very long city name that cannot fit in the compact field', 'Region', 'Germany'),
      v2City('Freising', 'Bavaria', 'Germany'),
    ],
  });

  assert.equal(view.summaryText, 'Germany … +2');
  assert.equal(view.hiddenCount, 2);
});

test('v1 locations use the same country tree', () => {
  const view = LocationDisplay.buildPresentation({
    locationModel: 'v1',
    maxSymbols: 200,
    locations: [
      { countryName: 'Germany', region: 'Bavaria', cityName: 'Freising' },
      { countryName: 'Germany', region: 'Saxony', cityName: 'Zwickau' },
    ],
  });

  assert.equal(view.summaryText, 'Germany: Freising, Zwickau');
  assert.equal(view.treeText, 'Germany\n  Bavaria: Freising\n  Saxony: Zwickau');
});

test('global regions stay visible without a country branch', () => {
  const view = LocationDisplay.buildPresentation({
    locationModel: 'v2',
    maxSymbols: 200,
    locationsV2: [
      { kind: 'globalRegion', locationId: 'm49:150', displayName: 'Europe' },
      v2City('Freising', 'Bavaria', 'Germany'),
    ],
  });

  assert.equal(view.summaryText, 'Europe; Germany: Freising');
  assert.equal(view.treeText, 'Europe\nGermany\n  Bavaria: Freising');
});

test('large location sets keep the direct location count', () => {
  const locationsV2 = Array.from({ length: 231 }, (_, index) =>
    v2City(`City ${String(index + 1).padStart(3, '0')}`, `Region ${index % 12}`, index < 200 ? 'Germany' : 'Switzerland')
  );

  const view = LocationDisplay.buildPresentation({ locationModel: 'v2', locationsV2, maxSymbols: 70 });

  assert.equal(view.totalCount, 231);
  assert.ok(view.hiddenCount > 0);
  assert.ok(LocationDisplay.symbolCount(view.summaryText) <= 70);
  assert.match(view.summaryText, /\+\d+$/);
});
