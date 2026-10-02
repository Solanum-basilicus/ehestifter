(function (w) {
  'use strict';

  const DEFAULT_MAX_SYMBOLS = 70;
  const GROUP_BURST = 3;
  const graphemeSegmenter = typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
    : null;

  let popover = null;
  let popoverBody = null;
  let popoverClose = null;
  let popoverTitle = null;
  let currentAnchor = null;
  let persistentTrigger = null;
  let persistent = false;
  let hideTimer = null;

  function clean(value) {
    return value == null ? '' : String(value).trim();
  }

  function symbolCount(value) {
    const text = String(value || '');
    if (!graphemeSegmenter) return Array.from(text).length;
    return Array.from(graphemeSegmenter.segment(text)).length;
  }

  function compareText(a, b) {
    return String(a).localeCompare(String(b), undefined, { sensitivity: 'base', numeric: true });
  }

  function normalizeV2(items) {
    const result = [];

    for (const raw of Array.isArray(items) ? items : []) {
      if (!raw || typeof raw !== 'object') continue;

      const kind = clean(raw.kind);
      const displayName = clean(raw.displayName);
      const fallbackLabel = clean(raw.label);
      const countryName = clean(raw.countryName || raw.countryCode);
      const adminRegionName = clean(raw.adminRegionName);

      if (!displayName && fallbackLabel) {
        result.push({
          kind: 'other',
          name: fallbackLabel,
          country: '',
          region: '',
        });
        continue;
      }

      if (kind === 'globalRegion') {
        const name = displayName || fallbackLabel || clean(raw.locationId);
        if (name) result.push({ kind, name, country: '', region: '' });
        continue;
      }

      if (kind === 'country') {
        const name = countryName || displayName || clean(raw.locationId);
        if (name) result.push({ kind, name, country: name, region: '' });
        continue;
      }

      if (kind === 'adminRegion') {
        const name = displayName || adminRegionName || clean(raw.locationId);
        if (name) result.push({ kind, name, country: countryName, region: name });
        continue;
      }

      if (kind === 'city') {
        const name = displayName || clean(raw.locationId);
        if (name) result.push({ kind, name, country: countryName, region: adminRegionName });
        continue;
      }

      const name = displayName || fallbackLabel || clean(raw.locationId);
      if (name) result.push({ kind: 'other', name, country: countryName, region: adminRegionName });
    }

    return result;
  }

  function normalizeV1(items) {
    const result = [];

    for (const raw of Array.isArray(items) ? items : []) {
      if (!raw || typeof raw !== 'object') continue;

      const country = clean(raw.countryName || raw.countryCode);
      const region = clean(raw.region);
      const city = clean(raw.cityName);

      if (city) {
        result.push({ kind: 'city', name: city, country, region });
      } else if (region) {
        result.push({ kind: 'adminRegion', name: region, country, region });
      } else if (country) {
        result.push({ kind: 'country', name: country, country, region: '' });
      }
    }

    return result;
  }

  function normalizeLocations(locationModel, locations, locationsV2) {
    return locationModel === 'v2' ? normalizeV2(locationsV2) : normalizeV1(locations);
  }

  function cityDuplicateKeys(entries) {
    const regionsByCity = new Map();

    for (const entry of entries) {
      if (entry.kind !== 'city') continue;
      const key = `${entry.country.toLocaleLowerCase()}\u0000${entry.name.toLocaleLowerCase()}`;
      if (!regionsByCity.has(key)) regionsByCity.set(key, new Set());
      regionsByCity.get(key).add(entry.region.toLocaleLowerCase());
    }

    const duplicates = new Set();
    for (const [key, regions] of regionsByCity.entries()) {
      if (regions.size > 1) duplicates.add(key);
    }
    return duplicates;
  }

  function inlineItemLabel(entry, duplicateCities) {
    if (entry.kind === 'country') return '';
    if (entry.kind === 'city') {
      const key = `${entry.country.toLocaleLowerCase()}\u0000${entry.name.toLocaleLowerCase()}`;
      if (duplicateCities.has(key) && entry.region) return `${entry.name} (${entry.region})`;
    }
    return entry.name;
  }

  function groupKey(entry) {
    if (entry.country) return `country:${entry.country.toLocaleLowerCase()}`;
    return `${entry.kind}:${entry.name.toLocaleLowerCase()}`;
  }

  function groupLabel(entry) {
    return entry.country || entry.name;
  }

  function kindRank(kind) {
    if (kind === 'country') return 0;
    if (kind === 'adminRegion') return 1;
    if (kind === 'city') return 2;
    if (kind === 'globalRegion') return 3;
    return 4;
  }

  function orderedEntries(entries, duplicateCities) {
    const groups = new Map();

    for (const entry of entries) {
      const key = groupKey(entry);
      if (!groups.has(key)) groups.set(key, { label: groupLabel(entry), entries: [] });
      groups.get(key).entries.push(entry);
    }

    const orderedGroups = Array.from(groups.values()).sort((a, b) => compareText(a.label, b.label));
    for (const group of orderedGroups) {
      group.entries.sort((a, b) => {
        const rank = kindRank(a.kind) - kindRank(b.kind);
        if (rank) return rank;
        return compareText(inlineItemLabel(a, duplicateCities), inlineItemLabel(b, duplicateCities));
      });
    }

    const result = [];
    const longest = Math.max(0, ...orderedGroups.map(group => group.entries.length));
    for (let offset = 0; offset < longest; offset += GROUP_BURST) {
      for (const group of orderedGroups) {
        result.push(...group.entries.slice(offset, offset + GROUP_BURST));
      }
    }
    return result;
  }

  function summaryBody(entries, duplicateCities) {
    const groups = [];
    const byKey = new Map();

    for (const entry of entries) {
      const key = groupKey(entry);
      let group = byKey.get(key);
      if (!group) {
        group = {
          country: entry.country,
          label: groupLabel(entry),
          items: [],
        };
        byKey.set(key, group);
        groups.push(group);
      }

      if (entry.kind === 'country' && entry.country) {
        continue;
      }

      const label = inlineItemLabel(entry, duplicateCities);
      if (label) group.items.push(label);
    }

    return groups.map(group => {
      if (group.country) {
        return group.items.length ? `${group.label}: ${group.items.join(', ')}` : group.label;
      }
      return group.items.length ? group.items.join(', ') : group.label;
    }).filter(Boolean).join('; ');
  }

  function withHiddenCount(body, hiddenCount) {
    if (hiddenCount <= 0) return body;
    return body ? `${body} … +${hiddenCount}` : `… +${hiddenCount}`;
  }

  function fallbackSummary(firstEntry, totalCount, maxSymbols) {
    const context = firstEntry.country || firstEntry.region || firstEntry.name;
    const text = withHiddenCount(context, totalCount);
    if (symbolCount(text) <= maxSymbols) {
      return { visibleText: context, hiddenCount: totalCount, summaryText: text };
    }
    const suffixOnly = withHiddenCount('', totalCount);
    return { visibleText: '', hiddenCount: totalCount, summaryText: suffixOnly };
  }

  function buildCompactSummary(entries, maxSymbols) {
    const totalCount = entries.length;
    if (!totalCount) return { visibleText: '', hiddenCount: 0, summaryText: '' };

    const duplicateCities = cityDuplicateKeys(entries);
    const ordered = orderedEntries(entries, duplicateCities);
    const fullBody = summaryBody(ordered, duplicateCities);
    if (symbolCount(fullBody) <= maxSymbols) {
      return { visibleText: fullBody, hiddenCount: 0, summaryText: fullBody };
    }

    const accepted = [];
    for (const entry of ordered) {
      const candidate = accepted.concat(entry);
      const body = summaryBody(candidate, duplicateCities);
      const hiddenCount = totalCount - candidate.length;
      if (symbolCount(withHiddenCount(body, hiddenCount)) > maxSymbols) break;
      accepted.push(entry);
    }

    if (!accepted.length) return fallbackSummary(ordered[0], totalCount, maxSymbols);

    const visibleText = summaryBody(accepted, duplicateCities);
    const hiddenCount = totalCount - accepted.length;
    return {
      visibleText,
      hiddenCount,
      summaryText: withHiddenCount(visibleText, hiddenCount),
    };
  }

  function findOrCreateCountry(countries, country) {
    const key = country.toLocaleLowerCase();
    if (!countries.has(key)) {
      countries.set(key, {
        type: 'country',
        label: country,
        direct: false,
        regions: new Map(),
        cities: [],
      });
    }
    return countries.get(key);
  }

  function findOrCreateRegion(countryNode, region) {
    const key = region.toLocaleLowerCase();
    if (!countryNode.regions.has(key)) {
      countryNode.regions.set(key, { label: region, direct: false, cities: [] });
    }
    return countryNode.regions.get(key);
  }

  function buildTree(entries) {
    const countries = new Map();
    const other = [];

    for (const entry of entries) {
      if (entry.country) {
        const country = findOrCreateCountry(countries, entry.country);

        if (entry.kind === 'country') {
          country.direct = true;
          continue;
        }

        if (entry.kind === 'adminRegion') {
          const region = findOrCreateRegion(country, entry.name || entry.region);
          region.direct = true;
          continue;
        }

        if (entry.kind === 'city') {
          if (entry.region) {
            findOrCreateRegion(country, entry.region).cities.push(entry.name);
          } else {
            country.cities.push(entry.name);
          }
          continue;
        }

        country.cities.push(entry.name);
        continue;
      }

      other.push({ type: 'leaf', label: entry.name });
    }

    const result = Array.from(countries.values()).map(country => ({
      type: country.type,
      label: country.label,
      direct: country.direct,
      regions: Array.from(country.regions.values())
        .map(region => ({
          label: region.label,
          direct: region.direct,
          cities: Array.from(new Set(region.cities)).sort(compareText),
        }))
        .sort((a, b) => compareText(a.label, b.label)),
      cities: Array.from(new Set(country.cities)).sort(compareText),
    }));

    result.push(...other);
    result.sort((a, b) => compareText(a.label, b.label));
    return result;
  }

  function treeToText(tree) {
    const lines = [];
    for (const node of tree) {
      lines.push(node.label);
      if (node.type !== 'country') continue;
      for (const region of node.regions) {
        lines.push(region.cities.length
          ? `  ${region.label}: ${region.cities.join(', ')}`
          : `  ${region.label}`);
      }
      if (node.cities.length) lines.push(`  ${node.cities.join(', ')}`);
    }
    return lines.join('\n');
  }

  function buildPresentation({ locationModel = 'v2', locations = [], locationsV2 = [], maxSymbols = DEFAULT_MAX_SYMBOLS } = {}) {
    const safeMax = Number.isFinite(Number(maxSymbols)) && Number(maxSymbols) > 0
      ? Math.floor(Number(maxSymbols))
      : DEFAULT_MAX_SYMBOLS;
    const entries = normalizeLocations(locationModel, locations, locationsV2);
    const compact = buildCompactSummary(entries, safeMax);
    const tree = buildTree(entries);

    return {
      ...compact,
      totalCount: entries.length,
      maxSymbols: safeMax,
      tree,
      treeText: treeToText(tree),
    };
  }

  function renderTree(container, tree) {
    container.replaceChildren();

    for (const node of tree) {
      const group = document.createElement('div');
      group.className = 'location-tree-group';

      const heading = document.createElement('div');
      heading.className = 'location-tree-heading';
      heading.textContent = node.label;
      group.appendChild(heading);

      if (node.type === 'country') {
        for (const region of node.regions) {
          const row = document.createElement('div');
          row.className = 'location-tree-row';

          const label = document.createElement('span');
          label.className = 'location-tree-region';
          label.textContent = region.cities.length ? `${region.label}:` : region.label;
          row.appendChild(label);

          if (region.cities.length) {
            row.appendChild(document.createTextNode(` ${region.cities.join(', ')}`));
          }
          group.appendChild(row);
        }

        if (node.cities.length) {
          const row = document.createElement('div');
          row.className = 'location-tree-row';
          row.textContent = node.cities.join(', ');
          group.appendChild(row);
        }
      }

      container.appendChild(group);
    }
  }

  function cancelHide() {
    if (!hideTimer) return;
    clearTimeout(hideTimer);
    hideTimer = null;
  }

  function closePopover(restoreFocus = false) {
    cancelHide();
    if (!popover) return;
    const focusTarget = restoreFocus ? persistentTrigger : null;
    if (persistentTrigger) persistentTrigger.setAttribute('aria-expanded', 'false');
    popover.classList.remove('is-open');
    popover.setAttribute('aria-hidden', 'true');
    currentAnchor = null;
    persistentTrigger = null;
    persistent = false;
    if (focusTarget && document.documentElement.contains(focusTarget)) focusTarget.focus();
  }

  function scheduleHide() {
    cancelHide();
    if (persistent) return;
    hideTimer = setTimeout(closePopover, 120);
  }

  function positionPopover() {
    if (!popover || !currentAnchor || !popover.classList.contains('is-open')) return;
    if (!document.documentElement.contains(currentAnchor)) {
      closePopover();
      return;
    }

    const margin = 12;
    const gap = 6;
    const anchorRect = currentAnchor.getBoundingClientRect();
    const rect = popover.getBoundingClientRect();
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;

    let left = anchorRect.left;
    if (left + rect.width > viewportWidth - margin) left = viewportWidth - rect.width - margin;
    left = Math.max(margin, left);

    let top = anchorRect.bottom + gap;
    if (top + rect.height > viewportHeight - margin && anchorRect.top > rect.height + gap + margin) {
      top = anchorRect.top - rect.height - gap;
    }
    top = Math.max(margin, Math.min(top, viewportHeight - rect.height - margin));

    popover.style.left = `${Math.round(left)}px`;
    popover.style.top = `${Math.round(top)}px`;
  }

  function ensurePopover() {
    if (popover || typeof document === 'undefined') return;

    popover = document.createElement('div');
    popover.id = 'location-popover';
    popover.className = 'location-popover';
    popover.setAttribute('aria-hidden', 'true');

    const header = document.createElement('div');
    header.className = 'location-popover-header';

    popoverTitle = document.createElement('div');
    popoverTitle.className = 'location-popover-title';
    popoverTitle.textContent = 'Locations';
    header.appendChild(popoverTitle);

    popoverClose = document.createElement('button');
    popoverClose.type = 'button';
    popoverClose.className = 'location-popover-close';
    popoverClose.setAttribute('aria-label', 'Close locations');
    popoverClose.textContent = '×';
    popoverClose.addEventListener('click', () => closePopover(true));
    header.appendChild(popoverClose);

    popoverBody = document.createElement('div');
    popoverBody.className = 'location-popover-body';

    popover.appendChild(header);
    popover.appendChild(popoverBody);
    document.body.appendChild(popover);

    popover.addEventListener('mouseenter', cancelHide);
    popover.addEventListener('mouseleave', scheduleHide);

    document.addEventListener('pointerdown', (event) => {
      if (!persistent || !popover.classList.contains('is-open')) return;
      if (popover.contains(event.target) || currentAnchor?.contains(event.target)) return;
      closePopover();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape' && popover.classList.contains('is-open')) closePopover(true);
    });

    window.addEventListener('resize', positionPopover);
    window.addEventListener('scroll', () => {
      if (persistent) positionPopover();
      else closePopover();
    }, true);
  }

  function openPopover(anchor, presentation, makePersistent, trigger = null) {
    if (!anchor || !presentation?.tree?.length || typeof document === 'undefined') return;
    ensurePopover();
    cancelHide();

    currentAnchor = anchor;
    persistent = Boolean(makePersistent);
    persistentTrigger = persistent ? trigger : null;
    if (persistentTrigger) persistentTrigger.setAttribute('aria-expanded', 'true');

    renderTree(popoverBody, presentation.tree);
    popoverTitle.textContent = `Locations (${presentation.totalCount})`;
    popoverClose.style.display = persistent ? '' : 'none';
    popover.setAttribute('role', persistent ? 'dialog' : 'tooltip');
    if (persistent) popover.setAttribute('aria-label', 'All locations');
    else popover.removeAttribute('aria-label');
    popover.classList.add('is-open');
    popover.setAttribute('aria-hidden', 'false');
    positionPopover();
  }

  function bindPopover(anchor, presentation, moreButton) {
    if (!anchor || !presentation?.tree?.length) return;
    const useful = presentation.totalCount > 1 || presentation.hiddenCount > 0;
    if (!useful) return;
    anchor.classList.add('has-location-popover');

    anchor.addEventListener('mouseenter', () => openPopover(anchor, presentation, false));
    anchor.addEventListener('mouseleave', scheduleHide);

    if (moreButton) {
      moreButton.addEventListener('focus', () => openPopover(anchor, presentation, false));
      moreButton.addEventListener('blur', scheduleHide);
      moreButton.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        openPopover(anchor, presentation, true, moreButton);
        popoverClose?.focus();
      });
    } else {
      anchor.tabIndex = 0;
      anchor.addEventListener('focus', () => openPopover(anchor, presentation, false));
      anchor.addEventListener('blur', scheduleHide);
    }
  }

  function renderInto(container, presentation, { remoteType = '', prefix = '' } = {}) {
    if (!container || typeof document === 'undefined') return false;
    container.replaceChildren();

    const remote = clean(remoteType);
    const hasGeo = Boolean(presentation?.summaryText);
    if (!hasGeo && !remote) return false;

    const inline = document.createElement('span');
    inline.className = 'location-inline';

    if (prefix) inline.appendChild(document.createTextNode(prefix));

    if (hasGeo) {
      const anchor = document.createElement('span');
      anchor.className = 'location-summary-anchor';

      if (presentation.hiddenCount > 0) {
        if (presentation.visibleText) {
          anchor.appendChild(document.createTextNode(`${presentation.visibleText} … `));
        } else {
          anchor.appendChild(document.createTextNode('… '));
        }

        const more = document.createElement('button');
        more.type = 'button';
        more.className = 'location-more';
        more.textContent = `+${presentation.hiddenCount}`;
        more.setAttribute('aria-label', `Show all ${presentation.totalCount} locations`);
        more.setAttribute('aria-haspopup', 'dialog');
        more.setAttribute('aria-controls', 'location-popover');
        more.setAttribute('aria-expanded', 'false');
        anchor.appendChild(more);
        bindPopover(anchor, presentation, more);
      } else {
        anchor.textContent = presentation.visibleText;
        bindPopover(anchor, presentation, null);
      }

      inline.appendChild(anchor);
    }

    if (remote) {
      if (hasGeo) inline.appendChild(document.createTextNode(` · ${remote}`));
      else inline.appendChild(document.createTextNode(remote));
    }

    container.appendChild(inline);
    return true;
  }

  w.LocationDisplay = Object.freeze({
    DEFAULT_MAX_SYMBOLS,
    buildPresentation,
    closePopover,
    renderInto,
    symbolCount,
    treeToText,
  });
})(window);
