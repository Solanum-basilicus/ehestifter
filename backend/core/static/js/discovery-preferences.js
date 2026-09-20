(function (w) {
  'use strict';

  const ARRANGEMENTS = [
    ['remote', 'Remote'],
    ['hybrid', 'Hybrid'],
    ['onSite', 'On-site'],
    ['unknown', 'Unknown work arrangement'],
  ];
  const RANGE_STEP = 15;
  const RANGE_MIN = -840;
  const RANGE_MAX = 840;

  function normalizeTerm(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function selectorKey(value) {
    return w.locationSelectorKey(value);
  }

  function stableDocument(document) {
    return JSON.stringify(document);
  }

  function formatOffset(minutes) {
    if (minutes === 0) return 'UTC±00:00';
    const sign = minutes < 0 ? '−' : '+';
    const absolute = Math.abs(minutes);
    const hours = String(Math.floor(absolute / 60)).padStart(2, '0');
    const mins = String(absolute % 60).padStart(2, '0');
    return `UTC${sign}${hours}:${mins}`;
  }

  async function requestJson(url, init = {}) {
    const response = await fetch(url, { credentials: 'same-origin', ...init });
    let payload = null;
    try { payload = await response.json(); } catch (_) { /* no-op */ }
    if (!response.ok) {
      const error = new Error(payload?.message || `Request failed (${response.status})`);
      error.payload = payload;
      error.status = response.status;
      throw error;
    }
    return payload || {};
  }

  class TermEditor {
    constructor(root, placeholder, onChange) {
      this.root = root;
      this.values = [];
      this.onChange = onChange;
      this.root.innerHTML = '';
      this.chips = document.createElement('div');
      this.chips.className = 'term-chips';
      const row = document.createElement('div');
      row.className = 'term-add-row';
      this.input = document.createElement('input');
      this.input.type = 'text';
      this.input.className = 'discovery-input';
      this.input.placeholder = placeholder;
      this.button = document.createElement('button');
      this.button.type = 'button';
      this.button.className = 'btn';
      this.button.textContent = 'Add';
      row.append(this.input, this.button);
      this.root.append(this.chips, row);
      this.button.addEventListener('click', () => this.addInput());
      this.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.addInput();
        }
      });
    }

    addInput() {
      const term = normalizeTerm(this.input.value);
      if (!term) return;
      if (!this.values.some((value) => value.toLowerCase() === term.toLowerCase())) {
        this.values.push(term);
        this.render();
        this.changed();
      }
      this.input.value = '';
      this.input.focus();
    }

    setValue(values) {
      this.values = (Array.isArray(values) ? values : []).map(normalizeTerm).filter(Boolean);
      this.render();
    }

    getValue() { return [...this.values]; }

    render() {
      this.chips.innerHTML = '';
      this.values.forEach((term) => {
        const chip = document.createElement('span');
        chip.className = 'term-chip';
        const label = document.createElement('span');
        label.textContent = term;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${term}`);
        remove.addEventListener('click', () => {
          this.values = this.values.filter((value) => value !== term);
          this.render();
          this.changed();
        });
        chip.append(label, remove);
        this.chips.appendChild(chip);
      });
    }

    setDisabled(disabled) {
      this.input.disabled = disabled;
      this.button.disabled = disabled;
      this.chips.querySelectorAll('button').forEach((button) => { button.disabled = disabled; });
    }

    changed() { if (this.onChange) this.onChange(); }
  }

  class RangeEditor {
    constructor(root, label, helpText, onChange) {
      this.root = root;
      this.label = label;
      this.helpText = helpText;
      this.onChange = onChange;
      this.values = [];
      this.renderShell();
    }

    renderShell() {
      this.root.innerHTML = '';
      const heading = document.createElement('div');
      heading.className = 'discovery-field-label';
      heading.textContent = this.label;
      const help = document.createElement('div');
      help.className = 'subtle small';
      help.textContent = this.helpText;
      this.list = document.createElement('div');
      this.list.className = 'range-list';
      const controls = document.createElement('div');
      controls.className = 'range-controls';
      this.start = this.offsetSelect();
      this.end = this.offsetSelect();
      this.end.value = '0';
      this.addButton = document.createElement('button');
      this.addButton.type = 'button';
      this.addButton.className = 'btn';
      this.addButton.textContent = 'Add range';
      controls.append(this.start, document.createTextNode('to'), this.end, this.addButton);
      this.error = document.createElement('div');
      this.error.className = 'err small';
      this.error.hidden = true;
      this.root.append(heading, help, this.list, controls, this.error);
      this.addButton.addEventListener('click', () => this.addCurrent());
      this.render();
    }

    offsetSelect() {
      const select = document.createElement('select');
      select.className = 'discovery-select';
      for (let value = RANGE_MIN; value <= RANGE_MAX; value += RANGE_STEP) {
        const option = document.createElement('option');
        option.value = String(value);
        option.textContent = formatOffset(value);
        if (value === 0) option.selected = true;
        select.appendChild(option);
      }
      return select;
    }

    addCurrent() {
      const startMinutes = Number(this.start.value);
      const endMinutes = Number(this.end.value);
      if (startMinutes > endMinutes) {
        this.error.hidden = false;
        this.error.textContent = 'The start offset must not be after the end offset.';
        return;
      }
      this.error.hidden = true;
      if (!this.values.some((value) => value.startMinutes === startMinutes && value.endMinutes === endMinutes)) {
        this.values.push({ startMinutes, endMinutes });
        this.values.sort((a, b) => a.startMinutes - b.startMinutes || a.endMinutes - b.endMinutes);
        this.render();
        if (this.onChange) this.onChange();
      }
    }

    setValue(values) {
      this.values = (Array.isArray(values) ? values : []).map((value) => ({
        startMinutes: Number(value.startMinutes),
        endMinutes: Number(value.endMinutes),
      }));
      this.render();
    }

    getValue() { return this.values.map((value) => ({ ...value })); }

    render() {
      if (!this.list) return;
      this.list.innerHTML = '';
      this.values.forEach((value, index) => {
        const chip = document.createElement('span');
        chip.className = 'range-chip';
        const label = document.createElement('span');
        label.textContent = `${formatOffset(value.startMinutes)} to ${formatOffset(value.endMinutes)}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove ${label.textContent}`);
        remove.addEventListener('click', () => {
          this.values.splice(index, 1);
          this.render();
          if (this.onChange) this.onChange();
        });
        chip.append(label, remove);
        this.list.appendChild(chip);
      });
    }

    setDisabled(disabled) {
      this.start.disabled = disabled;
      this.end.disabled = disabled;
      this.addButton.disabled = disabled;
      this.list.querySelectorAll('button').forEach((button) => { button.disabled = disabled; });
    }
  }

  function arrangementMarkup(key, label) {
    return `
      <section class="arrangement" data-arrangement="${key}">
        <label class="arrangement-toggle">
          <input type="checkbox" class="arrangement-enabled">
          <span>${label}</span>
        </label>
        <div class="arrangement-body" hidden>
          <div class="discovery-field">
            <div class="discovery-field-label">Include locations</div>
            <div class="subtle small">Leave empty to allow any known location for this work arrangement.</div>
            <div class="include-picker"></div>
          </div>
          <div class="discovery-field">
            <div class="discovery-field-label">Exclude locations</div>
            <div class="subtle small">A matching location branch is rejected.</div>
            <div class="exclude-picker"></div>
          </div>
          <label class="small unknown-location-label">
            <input type="checkbox" class="allow-unknown-location">
            Also allow jobs with no usable geography when location rules are set
          </label>
          <details class="advanced-rules">
            <summary>Advanced time rules</summary>
            <div class="utc-ranges"></div>
            <div class="work-time-ranges"></div>
          </details>
        </div>
      </section>`;
  }

  function init() {
    const box = document.getElementById('discovery-prefs');
    if (!box || !w.LocationPicker) return;

    const saveButton = document.getElementById('btn-save-discovery');
    const status = document.getElementById('discovery-status');
    const error = document.getElementById('discovery-error');
    const warning = document.getElementById('discovery-warning');
    const eligibilityEnabled = document.getElementById('eligibility-enabled');
    const eligibilityPanel = document.getElementById('eligibility-panel');
    const arrangementHost = document.getElementById('discovery-work-arrangements');
    const positiveRoot = document.getElementById('title-positive');
    const negativeRoot = document.getElementById('title-negative');

    let busy = false;
    let baseline = '';
    let loadedEligibilityWasNull = true;
    const editors = {};

    const titlePositive = new TermEditor(positiveRoot, 'Example: Product Manager', syncDirty);
    const titleNegative = new TermEditor(negativeRoot, 'Example: Junior Product Manager', syncDirty);

    arrangementHost.innerHTML = ARRANGEMENTS.map(([key, label]) => arrangementMarkup(key, label)).join('');
    for (const [key] of ARRANGEMENTS) {
      const section = arrangementHost.querySelector(`[data-arrangement="${key}"]`);
      const enabled = section.querySelector('.arrangement-enabled');
      const body = section.querySelector('.arrangement-body');
      const allowUnknown = section.querySelector('.allow-unknown-location');
      const includePicker = new w.LocationPicker(section.querySelector('.include-picker'), { onChange: syncDirty });
      const excludePicker = new w.LocationPicker(section.querySelector('.exclude-picker'), { onChange: syncDirty });
      const utcRanges = new RangeEditor(
        section.querySelector('.utc-ranges'),
        'Geographic UTC offsets to allow',
        'Use this for the time zones of job locations. It is not an employer work-hours rule.',
        syncDirty,
      );
      const workRanges = new RangeEditor(
        section.querySelector('.work-time-ranges'),
        'Employer work-time ranges to reject',
        'Reject a job when its explicit required work-time range overlaps one of these ranges.',
        syncDirty,
      );
      enabled.addEventListener('change', () => {
        body.hidden = !enabled.checked;
        syncDisabled();
        syncDirty();
      });
      allowUnknown.addEventListener('change', syncDirty);
      editors[key] = { section, enabled, body, allowUnknown, includePicker, excludePicker, utcRanges, workRanges };
    }

    eligibilityEnabled.addEventListener('change', () => {
      eligibilityPanel.hidden = !eligibilityEnabled.checked;
      if (eligibilityEnabled.checked && loadedEligibilityWasNull) {
        for (const editor of Object.values(editors)) {
          editor.enabled.checked = true;
          editor.body.hidden = false;
        }
        loadedEligibilityWasNull = false;
      }
      syncDisabled();
      syncDirty();
    });

    function setError(message) {
      error.hidden = !message;
      error.textContent = message || '';
    }

    function setWarning(message) {
      warning.hidden = !message;
      warning.textContent = message || '';
    }

    function setBusy(value, label = '') {
      busy = value;
      box.setAttribute('aria-busy', value ? 'true' : 'false');
      status.hidden = !value;
      status.textContent = value ? label : '';
      syncDisabled();
      syncDirty();
    }

    function syncDisabled() {
      const rulesDisabled = busy || !eligibilityEnabled.checked;
      eligibilityEnabled.disabled = busy;
      titlePositive.setDisabled(busy);
      titleNegative.setDisabled(busy);
      for (const editor of Object.values(editors)) {
        editor.enabled.disabled = rulesDisabled;
        const groupDisabled = rulesDisabled || !editor.enabled.checked;
        editor.includePicker.setDisabled(groupDisabled);
        editor.excludePicker.setDisabled(groupDisabled);
        editor.allowUnknown.disabled = groupDisabled;
        editor.utcRanges.setDisabled(groupDisabled);
        editor.workRanges.setDisabled(groupDisabled);
      }
      saveButton.disabled = busy || stableDocument(buildDocument()) === baseline;
    }

    function buildDocument() {
      let eligibility = null;
      if (eligibilityEnabled.checked) {
        eligibility = {};
        for (const [key] of ARRANGEMENTS) {
          const editor = editors[key];
          if (!editor.enabled.checked) continue;
          eligibility[key] = {
            includeLocations: editor.includePicker.getValue(),
            excludeLocations: editor.excludePicker.getValue(),
            utcOffsetRanges: editor.utcRanges.getValue(),
            excludeWorkTimeRanges: editor.workRanges.getValue(),
            allowUnknownLocation: editor.allowUnknown.checked,
          };
        }
      }
      return {
        schemaVersion: 1,
        title: {
          positive: titlePositive.getValue(),
          negative: titleNegative.getValue(),
        },
        eligibility,
      };
    }

    function syncDirty() {
      if (!saveButton) return;
      saveButton.disabled = busy || stableDocument(buildDocument()) === baseline;
    }

    function setDocument(payload) {
      const details = new Map((payload.locationDetails || []).map((item) => [selectorKey(item), item]));
      titlePositive.setValue(payload.title?.positive || []);
      titleNegative.setValue(payload.title?.negative || []);
      const eligibility = payload.eligibility;
      loadedEligibilityWasNull = eligibility == null;
      eligibilityEnabled.checked = eligibility != null;
      eligibilityPanel.hidden = eligibility == null;

      for (const [key] of ARRANGEMENTS) {
        const editor = editors[key];
        const group = eligibility && Object.prototype.hasOwnProperty.call(eligibility, key)
          ? eligibility[key]
          : null;
        editor.enabled.checked = Boolean(group);
        editor.body.hidden = !group;
        editor.includePicker.setValue(group?.includeLocations || [], details);
        editor.excludePicker.setValue(group?.excludeLocations || [], details);
        editor.utcRanges.setValue(group?.utcOffsetRanges || []);
        editor.workRanges.setValue(group?.excludeWorkTimeRanges || []);
        editor.allowUnknown.checked = Boolean(group?.allowUnknownLocation);
      }

      const missing = Array.isArray(payload.missingLocations) ? payload.missingLocations : [];
      setWarning(missing.length
        ? 'Some saved locations are no longer in the current catalog. Remove or replace the marked values before saving.'
        : '');
      baseline = stableDocument(buildDocument());
      syncDisabled();
    }

    async function load() {
      setBusy(true, 'Loading…');
      setError('');
      try {
        const payload = await requestJson('/ui/users/discovery-preferences');
        setDocument(payload);
      } catch (loadError) {
        setError(loadError.message || 'Failed to load discovery preferences.');
      } finally {
        setBusy(false);
      }
    }

    saveButton.addEventListener('click', async () => {
      if (busy) return;
      setBusy(true, 'Validating and saving…');
      setError('');
      try {
        const document = buildDocument();
        const positive = new Set(document.title.positive.map((value) => value.toLowerCase()));
        const contradiction = document.title.negative.find((value) => positive.has(value.toLowerCase()));
        if (contradiction) throw new Error(`The title term "${contradiction}" is both included and excluded.`);

        const payload = await requestJson('/ui/users/discovery-preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(document),
        });
        setDocument(payload);
      } catch (saveError) {
        setError(saveError.message || 'Failed to save discovery preferences.');
      } finally {
        setBusy(false);
      }
    });

    load();
  }

  document.addEventListener('DOMContentLoaded', init);
})(window);
