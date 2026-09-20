(function (w) {
  'use strict';

  let pickerSequence = 0;
  const searchCache = new Map();
  const SEARCH_CACHE_LIMIT = 40;

  function selectorKey(value) {
    return `${value?.kind || ''}|${value?.locationId || ''}`;
  }

  function isSearchable(query) {
    const value = String(query || '').trim();
    return value.length >= 3 || /^[A-Za-z]{2}$/.test(value);
  }

  async function readJson(response) {
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* no-op */ }
    if (!response.ok) {
      const message = payload?.message || payload?.error || `Location search failed (${response.status})`;
      throw new Error(message);
    }
    return payload || {};
  }

  class LocationPicker {
    constructor(root, options = {}) {
      if (!root) throw new Error('LocationPicker root is required');
      this.root = root;
      this.options = options;
      this.selected = [];
      this.results = [];
      this.activeIndex = -1;
      this.timer = null;
      this.controller = null;
      this.id = `location-picker-${++pickerSequence}`;
      this.renderShell();
      this.bind();
    }

    renderShell() {
      this.root.classList.add('location-picker');
      this.root.innerHTML = '';

      this.selectedEl = document.createElement('div');
      this.selectedEl.className = 'location-picker-selected';

      const inputRow = document.createElement('div');
      inputRow.className = 'location-picker-input-row';
      this.input = document.createElement('input');
      this.input.type = 'text';
      this.input.className = 'discovery-input location-picker-input';
      this.input.placeholder = this.options.placeholder || 'Search city, region, country, or global region';
      this.input.setAttribute('role', 'combobox');
      this.input.setAttribute('aria-autocomplete', 'list');
      this.input.setAttribute('aria-expanded', 'false');
      this.input.setAttribute('aria-controls', `${this.id}-listbox`);
      this.input.autocomplete = 'off';
      inputRow.appendChild(this.input);

      this.menu = document.createElement('div');
      this.menu.id = `${this.id}-listbox`;
      this.menu.className = 'location-picker-menu';
      this.menu.setAttribute('role', 'listbox');
      this.menu.hidden = true;

      this.hint = document.createElement('div');
      this.hint.className = 'subtle small location-picker-hint';
      this.hint.textContent = this.options.hint || 'Type 3 characters. A 2-letter country code also works.';

      this.root.append(this.selectedEl, inputRow, this.menu, this.hint);
      this.renderSelected();
    }

    bind() {
      this.input.addEventListener('input', () => this.scheduleSearch());
      this.input.addEventListener('keydown', (event) => this.onKeyDown(event));
      this.input.addEventListener('blur', () => {
        window.setTimeout(() => this.closeMenu(), 120);
      });
      this.input.addEventListener('focus', () => {
        if (this.results.length) this.openMenu();
      });
    }

    scheduleSearch() {
      window.clearTimeout(this.timer);
      const query = this.input.value.trim();
      if (!isSearchable(query)) {
        this.results = [];
        this.renderResults();
        return;
      }
      this.timer = window.setTimeout(() => this.search(query), 250);
    }

    async search(query) {
      if (this.controller) this.controller.abort();
      const cacheKey = query.trim().toLocaleLowerCase();
      let items = searchCache.get(cacheKey);

      try {
        if (!items) {
          this.controller = new AbortController();
          this.renderMessage('Searching… This can take a few seconds.');
          const params = new URLSearchParams({ q: query, limit: '8' });
          const response = await fetch(`/ui/locations/search?${params.toString()}`, {
            credentials: 'same-origin',
            signal: this.controller.signal,
          });
          const payload = await readJson(response);
          items = Array.isArray(payload.items) ? payload.items : [];
          searchCache.set(cacheKey, items);
          if (searchCache.size > SEARCH_CACHE_LIMIT) {
            searchCache.delete(searchCache.keys().next().value);
          }
        }
        if (this.input.value.trim() !== query) return;
        const selectedKeys = new Set(this.selected.map(selectorKey));
        this.results = items.filter((item) => !selectedKeys.has(selectorKey(item)));
        this.activeIndex = this.results.length ? 0 : -1;
        if (this.results.length) this.renderResults();
        else this.renderMessage('No matching locations.');
      } catch (error) {
        if (error?.name === 'AbortError') return;
        this.results = [];
        this.activeIndex = -1;
        this.renderMessage(error?.message || 'Location search failed');
      }
    }

    renderMessage(message) {
      this.menu.innerHTML = '';
      const row = document.createElement('div');
      row.className = 'location-picker-empty';
      row.textContent = message;
      this.menu.appendChild(row);
      this.openMenu();
    }

    renderResults() {
      this.menu.innerHTML = '';
      if (!this.results.length) {
        this.closeMenu();
        return;
      }

      this.results.forEach((item, index) => {
        const option = document.createElement('div');
        option.id = `${this.id}-option-${index}`;
        option.className = `location-picker-option${index === this.activeIndex ? ' is-active' : ''}`;
        option.setAttribute('role', 'option');
        option.setAttribute('aria-selected', index === this.activeIndex ? 'true' : 'false');
        option.addEventListener('mousedown', (event) => {
          event.preventDefault();
          this.add(item);
        });

        const main = document.createElement('div');
        main.className = 'location-picker-option-main';
        const name = document.createElement('strong');
        name.textContent = item.displayName || item.locationId || 'Unknown location';
        const kind = document.createElement('span');
        kind.className = 'location-kind';
        kind.textContent = this.kindLabel(item.kind);
        main.append(name, kind);

        const context = document.createElement('div');
        context.className = 'subtle small';
        context.textContent = item.contextLabel || item.countryName || '';
        option.append(main, context);
        this.menu.appendChild(option);
      });
      this.openMenu();
      this.syncActiveDescendant();
    }

    kindLabel(kind) {
      return ({
        city: 'City',
        adminRegion: 'Region',
        country: 'Country',
        globalRegion: 'Global region',
      })[kind] || 'Location';
    }

    onKeyDown(event) {
      if (!this.results.length || this.menu.hidden) {
        if (event.key === 'Escape') this.closeMenu();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        this.activeIndex = (this.activeIndex + 1) % this.results.length;
        this.renderResults();
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        this.activeIndex = (this.activeIndex - 1 + this.results.length) % this.results.length;
        this.renderResults();
      } else if (event.key === 'Enter' && this.activeIndex >= 0) {
        event.preventDefault();
        this.add(this.results[this.activeIndex]);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        this.closeMenu();
      }
    }

    syncActiveDescendant() {
      if (this.activeIndex >= 0) {
        this.input.setAttribute('aria-activedescendant', `${this.id}-option-${this.activeIndex}`);
      } else {
        this.input.removeAttribute('aria-activedescendant');
      }
    }

    openMenu() {
      this.menu.hidden = false;
      this.input.setAttribute('aria-expanded', 'true');
    }

    closeMenu() {
      this.menu.hidden = true;
      this.input.setAttribute('aria-expanded', 'false');
      this.input.removeAttribute('aria-activedescendant');
    }

    add(item) {
      const key = selectorKey(item);
      if (!key || this.selected.some((value) => selectorKey(value) === key)) return;
      this.selected.push({ ...item });
      this.input.value = '';
      this.results = [];
      this.activeIndex = -1;
      this.renderSelected();
      this.renderResults();
      this.changed();
      this.input.focus();
    }

    remove(key) {
      this.selected = this.selected.filter((item) => selectorKey(item) !== key);
      this.renderSelected();
      this.changed();
    }

    renderSelected() {
      this.selectedEl.innerHTML = '';
      this.selected.forEach((item) => {
        const chip = document.createElement('span');
        chip.className = `location-chip${item.stale ? ' is-stale' : ''}`;
        const label = document.createElement('span');
        label.textContent = item.label || item.displayName || item.locationId;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'location-chip-remove';
        remove.setAttribute('aria-label', `Remove ${label.textContent}`);
        remove.textContent = '×';
        remove.addEventListener('click', () => this.remove(selectorKey(item)));
        chip.append(label, remove);
        this.selectedEl.appendChild(chip);
      });
    }

    setValue(selectors, detailsByKey) {
      this.selected = (Array.isArray(selectors) ? selectors : []).map((selector) => {
        const detail = detailsByKey?.get(selectorKey(selector));
        if (detail) return { ...detail };
        return {
          ...selector,
          displayName: selector.locationId,
          label: `${selector.kind}: ${selector.locationId}`,
          stale: true,
        };
      });
      this.renderSelected();
    }

    getValue() {
      return this.selected.map((item) => ({
        kind: item.kind,
        locationId: item.locationId,
      }));
    }

    getItems() {
      return this.selected.map((item) => ({ ...item }));
    }

    setItems(items) {
      this.selected = (Array.isArray(items) ? items : []).map((item) => ({ ...item }));
      this.renderSelected();
    }

    setDisabled(disabled) {
      this.input.disabled = Boolean(disabled);
      this.root.classList.toggle('is-disabled', Boolean(disabled));
      this.root.querySelectorAll('.location-chip-remove').forEach((button) => {
        button.disabled = Boolean(disabled);
      });
      if (disabled) this.closeMenu();
    }

    changed() {
      if (typeof this.options.onChange === 'function') this.options.onChange(this.getValue());
    }
  }

  w.LocationPicker = LocationPicker;
  w.locationSelectorKey = selectorKey;
})(window);
