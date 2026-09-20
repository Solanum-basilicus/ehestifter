(function (w) {
  'use strict';

  const ARRANGEMENTS = [
    ['remote', 'Remote'],
    ['hybrid', 'Hybrid'],
    ['onSite', 'On-site'],
    ['unknown', 'Unknown work arrangement'],
  ];
  const LINKABLE_ARRANGEMENTS = new Set(['remote', 'hybrid', 'onSite']);
  const RANGE_STEP = 15;
  const RANGE_MIN = -840;
  const RANGE_MAX = 840;
  const PATTERN_GAP_WORDS = 2;
  const TERM_COLLAPSE_LIMIT = 20;

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

  function arrangementLabel(key) {
    return ARRANGEMENTS.find(([candidate]) => candidate === key)?.[1] || key;
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
      this.expanded = false;
      this.onChange = onChange;
      this.root.innerHTML = '';

      this.normal = document.createElement('div');
      this.chips = document.createElement('div');
      this.chips.className = 'term-chips';
      this.toggle = document.createElement('button');
      this.toggle.type = 'button';
      this.toggle.className = 'btn small term-toggle';
      this.toggle.hidden = true;
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
      this.bulkButton = document.createElement('button');
      this.bulkButton.type = 'button';
      this.bulkButton.className = 'btn';
      this.bulkButton.textContent = 'Bulk edit';
      row.append(this.input, this.button, this.bulkButton);
      this.normal.append(this.chips, this.toggle, row);

      this.bulk = document.createElement('div');
      this.bulk.className = 'bulk-editor';
      this.bulk.hidden = true;
      this.bulkText = document.createElement('textarea');
      this.bulkText.className = 'discovery-input bulk-editor-text';
      this.bulkText.rows = 12;
      this.bulkText.placeholder = 'One title phrase per line';
      const bulkHelp = document.createElement('div');
      bulkHelp.className = 'subtle small';
      bulkHelp.textContent = 'One title phrase per line. Empty lines and duplicates are removed.';
      const bulkActions = document.createElement('div');
      bulkActions.className = 'btn-row';
      this.bulkApply = document.createElement('button');
      this.bulkApply.type = 'button';
      this.bulkApply.className = 'btn';
      this.bulkApply.textContent = 'Apply bulk edit';
      this.bulkCancel = document.createElement('button');
      this.bulkCancel.type = 'button';
      this.bulkCancel.className = 'btn';
      this.bulkCancel.textContent = 'Cancel';
      bulkActions.append(this.bulkApply, this.bulkCancel);
      this.bulk.append(this.bulkText, bulkHelp, bulkActions);

      this.root.append(this.normal, this.bulk);
      this.button.addEventListener('click', () => this.addInput());
      this.input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
          event.preventDefault();
          this.addInput();
        }
      });
      this.bulkButton.addEventListener('click', () => this.openBulk());
      this.toggle.addEventListener('click', () => { this.expanded = !this.expanded; this.render(); });
      this.bulkApply.addEventListener('click', () => this.applyBulk());
      this.bulkCancel.addEventListener('click', () => this.closeBulk());
    }

    addInput() {
      const term = normalizeTerm(this.input.value);
      if (!term) return;
      if (!this.values.some((value) => value.toLowerCase() === term.toLowerCase())) {
        this.values.push(term);
        if (this.values.length > TERM_COLLAPSE_LIMIT) this.expanded = true;
        this.render();
        this.changed();
      }
      this.input.value = '';
      this.input.focus();
    }

    openBulk() {
      this.bulkText.value = this.values.join('\n');
      this.normal.hidden = true;
      this.bulk.hidden = false;
      this.bulkText.focus();
    }

    closeBulk() {
      this.bulk.hidden = true;
      this.normal.hidden = false;
    }

    applyBulk() {
      const values = [];
      const seen = new Set();
      for (const line of this.bulkText.value.split(/\r?\n/)) {
        const term = normalizeTerm(line);
        if (!term) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        values.push(term);
      }
      this.values = values;
      this.expanded = false;
      this.render();
      this.closeBulk();
      this.changed();
    }

    setValue(values) {
      const result = [];
      const seen = new Set();
      for (const raw of Array.isArray(values) ? values : []) {
        const term = normalizeTerm(raw);
        if (!term) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(term);
      }
      this.values = result;
      this.expanded = false;
      this.render();
      this.closeBulk();
    }

    getValue() { return [...this.values]; }

    render() {
      this.chips.innerHTML = '';
      const visible = this.expanded ? this.values : this.values.slice(0, TERM_COLLAPSE_LIMIT);
      visible.forEach((term) => {
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
          if (this.values.length <= TERM_COLLAPSE_LIMIT) this.expanded = false;
          this.render();
          this.changed();
        });
        chip.append(label, remove);
        this.chips.appendChild(chip);
      });
      this.toggle.hidden = this.values.length <= TERM_COLLAPSE_LIMIT;
      this.toggle.textContent = this.expanded
        ? 'Show fewer'
        : `Show all (${this.values.length})`;
    }

    setDisabled(disabled) {
      this.input.disabled = disabled;
      this.button.disabled = disabled;
      this.bulkButton.disabled = disabled;
      this.toggle.disabled = disabled;
      this.bulkText.disabled = disabled;
      this.bulkApply.disabled = disabled;
      this.bulkCancel.disabled = disabled;
      this.chips.querySelectorAll('button').forEach((button) => { button.disabled = disabled; });
    }

    changed() { if (this.onChange) this.onChange(); }
  }

  class PatternEditor {
    constructor(root, onChange) {
      this.root = root;
      this.onChange = onChange;
      this.patterns = [];
      this.root.innerHTML = '';

      this.list = document.createElement('div');
      this.list.className = 'pattern-list';
      const form = document.createElement('div');
      form.className = 'pattern-form';
      this.left = document.createElement('input');
      this.left.type = 'text';
      this.left.className = 'discovery-input';
      this.left.placeholder = 'Engineering';
      const relation = document.createElement('span');
      relation.className = 'subtle small pattern-relation';
      relation.textContent = 'within up to 2 words of';
      this.right = document.createElement('input');
      this.right.type = 'text';
      this.right.className = 'discovery-input';
      this.right.placeholder = 'Manager, Lead';
      this.addButton = document.createElement('button');
      this.addButton.type = 'button';
      this.addButton.className = 'btn';
      this.addButton.textContent = 'Add pattern';
      form.append(this.left, relation, this.right, this.addButton);
      this.error = document.createElement('div');
      this.error.className = 'err small';
      this.error.hidden = true;
      this.root.append(this.list, form, this.error);

      this.addButton.addEventListener('click', () => this.addCurrent());
      for (const input of [this.left, this.right]) {
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            this.addCurrent();
          }
        });
      }
    }

    alternatives(value) {
      const result = [];
      const seen = new Set();
      for (const raw of String(value || '').split(/[,\n]/)) {
        const term = normalizeTerm(raw);
        if (!term) continue;
        const key = term.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(term);
      }
      return result;
    }

    patternKey(pattern) {
      return JSON.stringify({
        left: pattern.left.map((value) => value.toLowerCase()),
        right: pattern.right.map((value) => value.toLowerCase()),
      });
    }

    addCurrent() {
      const left = this.alternatives(this.left.value);
      const right = this.alternatives(this.right.value);
      if (!left.length || !right.length) {
        this.error.hidden = false;
        this.error.textContent = 'Add at least one phrase on each side of the pattern.';
        return;
      }
      this.error.hidden = true;
      const pattern = {
        type: 'orderedGap',
        left,
        right,
        maxGapWords: PATTERN_GAP_WORDS,
      };
      const key = this.patternKey(pattern);
      if (!this.patterns.some((value) => this.patternKey(value) === key)) {
        this.patterns.push(pattern);
        this.render();
        if (this.onChange) this.onChange();
      }
      this.left.value = '';
      this.right.value = '';
      this.left.focus();
    }

    setValue(values) {
      this.patterns = (Array.isArray(values) ? values : [])
        .filter((value) => value && value.type === 'orderedGap')
        .map((value) => ({
          type: 'orderedGap',
          left: (Array.isArray(value.left) ? value.left : []).map(normalizeTerm).filter(Boolean),
          right: (Array.isArray(value.right) ? value.right : []).map(normalizeTerm).filter(Boolean),
          maxGapWords: PATTERN_GAP_WORDS,
        }))
        .filter((value) => value.left.length && value.right.length);
      this.render();
    }

    getValue() {
      return this.patterns.map((value) => ({
        type: 'orderedGap',
        left: [...value.left],
        right: [...value.right],
        maxGapWords: PATTERN_GAP_WORDS,
      }));
    }

    render() {
      this.list.innerHTML = '';
      this.patterns.forEach((pattern, index) => {
        const row = document.createElement('div');
        row.className = 'pattern-chip';
        const text = document.createElement('span');
        text.textContent = `${pattern.left.join(' / ')} → ≤2 words → ${pattern.right.join(' / ')}`;
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.textContent = '×';
        remove.setAttribute('aria-label', `Remove pattern ${text.textContent}`);
        remove.addEventListener('click', () => {
          this.patterns.splice(index, 1);
          this.render();
          if (this.onChange) this.onChange();
        });
        row.append(text, remove);
        this.list.appendChild(row);
      });
    }

    setDisabled(disabled) {
      this.left.disabled = disabled;
      this.right.disabled = disabled;
      this.addButton.disabled = disabled;
      this.list.querySelectorAll('button').forEach((button) => { button.disabled = disabled; });
    }
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
    const linkControls = LINKABLE_ARRANGEMENTS.has(key)
      ? `
        <div class="arrangement-link-controls">
          <select class="discovery-select arrangement-link-select" aria-label="Use the same rules as another work arrangement">
            <option value="">Use same rules as…</option>
          </select>
          <button type="button" class="btn arrangement-separate" hidden>Separate</button>
        </div>`
      : '';
    return `
      <section class="arrangement" data-arrangement="${key}">
        <div class="arrangement-heading">
          <label class="arrangement-toggle">
            <input type="checkbox" class="arrangement-enabled">
            <span class="arrangement-label">${label}</span>
          </label>
          ${linkControls}
        </div>
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
          <div class="coverage-controls">
            <button type="button" class="btn coverage-button">Preview geographic coverage</button>
            <span class="subtle small coverage-status"></span>
          </div>
          <div class="coverage-preview" hidden></div>
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
    const positivePatternsRoot = document.getElementById('title-positive-patterns');
    const negativeRoot = document.getElementById('title-negative');

    let busy = false;
    let baseline = '';
    let loadedEligibilityWasNull = true;
    const editors = {};
    let linkGroups = [];

    const titlePositive = new TermEditor(positiveRoot, 'Example: Product Manager', syncDirty);
    const titlePositivePatterns = new PatternEditor(positivePatternsRoot, syncDirty);
    const titleNegative = new TermEditor(negativeRoot, 'Example: Junior Product Manager', syncDirty);

    arrangementHost.innerHTML = ARRANGEMENTS.map(([key, label]) => arrangementMarkup(key, label)).join('');
    for (const [key, label] of ARRANGEMENTS) {
      const section = arrangementHost.querySelector(`[data-arrangement="${key}"]`);
      const enabled = section.querySelector('.arrangement-enabled');
      const body = section.querySelector('.arrangement-body');
      const allowUnknown = section.querySelector('.allow-unknown-location');
      const labelEl = section.querySelector('.arrangement-label');
      const linkSelect = section.querySelector('.arrangement-link-select');
      const separateButton = section.querySelector('.arrangement-separate');
      const coverageButton = section.querySelector('.coverage-button');
      const coverageStatus = section.querySelector('.coverage-status');
      const coveragePreview = section.querySelector('.coverage-preview');
      const geoChanged = () => {
        markCoverageStale(key);
        syncDirty();
      };
      const includePicker = new w.LocationPicker(section.querySelector('.include-picker'), { onChange: geoChanged });
      const excludePicker = new w.LocationPicker(section.querySelector('.exclude-picker'), { onChange: geoChanged });
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
        markCoverageStale(key);
        syncDisabled();
        syncDirty();
      });
      allowUnknown.addEventListener('change', geoChanged);
      if (linkSelect) {
        linkSelect.addEventListener('change', () => {
          const target = linkSelect.value;
          linkSelect.value = '';
          if (target) linkArrangementGroups(key, target);
        });
      }
      if (separateButton) {
        separateButton.addEventListener('click', () => separateArrangementGroup(key));
      }
      coverageButton.addEventListener('click', () => loadCoverage(key));
      editors[key] = {
        key,
        baseLabel: label,
        section,
        enabled,
        body,
        allowUnknown,
        labelEl,
        linkSelect,
        separateButton,
        coverageButton,
        coverageStatus,
        coveragePreview,
        coverageFingerprint: null,
        includePicker,
        excludePicker,
        utcRanges,
        workRanges,
      };
    }

    resetLinkGroups();

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

    function resetLinkGroups() {
      linkGroups = [...LINKABLE_ARRANGEMENTS].map((key) => ({
        members: new Set([key]),
        representative: key,
      }));
      renderLinkGroups();
    }

    function groupFor(key) {
      if (!LINKABLE_ARRANGEMENTS.has(key)) {
        return { members: new Set([key]), representative: key };
      }
      return linkGroups.find((group) => group.members.has(key));
    }

    function orderedMembers(group) {
      return ARRANGEMENTS
        .map(([key]) => key)
        .filter((key) => group.members.has(key));
    }

    function snapshotEditor(editor) {
      return {
        enabled: editor.enabled.checked,
        includeItems: editor.includePicker.getItems(),
        excludeItems: editor.excludePicker.getItems(),
        utcOffsetRanges: editor.utcRanges.getValue(),
        excludeWorkTimeRanges: editor.workRanges.getValue(),
        allowUnknownLocation: editor.allowUnknown.checked,
      };
    }

    function applySnapshot(editor, snapshot) {
      editor.enabled.checked = snapshot.enabled;
      editor.body.hidden = !snapshot.enabled;
      editor.includePicker.setItems(snapshot.includeItems);
      editor.excludePicker.setItems(snapshot.excludeItems);
      editor.utcRanges.setValue(snapshot.utcOffsetRanges);
      editor.workRanges.setValue(snapshot.excludeWorkTimeRanges);
      editor.allowUnknown.checked = snapshot.allowUnknownLocation;
      editor.coverageFingerprint = null;
      editor.coveragePreview.hidden = true;
      editor.coverageStatus.textContent = '';
    }

    function linkArrangementGroups(sourceKey, targetKey) {
      if (!LINKABLE_ARRANGEMENTS.has(sourceKey) || !LINKABLE_ARRANGEMENTS.has(targetKey)) return;
      const sourceGroup = groupFor(sourceKey);
      const targetGroup = groupFor(targetKey);
      if (sourceGroup === targetGroup) return;

      // "Use same rules as" adopts the current target rules. This also keeps
      // unsaved changes in an existing target group.
      const targetSnapshot = snapshotEditor(editors[targetGroup.representative]);
      targetSnapshot.enabled = true;
      const members = new Set([...sourceGroup.members, ...targetGroup.members]);
      for (const member of members) applySnapshot(editors[member], targetSnapshot);
      linkGroups = linkGroups.filter((group) => group !== sourceGroup && group !== targetGroup);
      linkGroups.push({ members, representative: targetGroup.representative });
      renderLinkGroups();
      syncDisabled();
      syncDirty();
    }

    function separateArrangementGroup(key) {
      const group = groupFor(key);
      if (!group || group.members.size <= 1) return;
      const snapshot = snapshotEditor(editors[group.representative]);
      linkGroups = linkGroups.filter((candidate) => candidate !== group);
      for (const member of orderedMembers(group)) {
        applySnapshot(editors[member], snapshot);
        linkGroups.push({ members: new Set([member]), representative: member });
      }
      renderLinkGroups();
      syncDisabled();
      syncDirty();
    }

    function renderLinkGroups() {
      for (const key of LINKABLE_ARRANGEMENTS) {
        const editor = editors[key];
        if (!editor) continue;
        const group = groupFor(key);
        const isRepresentative = group.representative === key;
        editor.section.hidden = group.members.size > 1 && !isRepresentative;
        if (!isRepresentative) continue;

        const members = orderedMembers(group);
        editor.labelEl.textContent = members.map(arrangementLabel).join(' + ');
        if (editor.separateButton) editor.separateButton.hidden = group.members.size <= 1;
        if (editor.linkSelect) {
          editor.linkSelect.hidden = group.members.size > 1;
          editor.linkSelect.innerHTML = '<option value="">Use same rules as…</option>';
          if (group.members.size === 1) {
            for (const candidate of LINKABLE_ARRANGEMENTS) {
              if (candidate === key) continue;
              const option = document.createElement('option');
              option.value = candidate;
              option.textContent = arrangementLabel(candidate);
              editor.linkSelect.appendChild(option);
            }
          }
        }
      }
    }

    function activeEditorFor(key) {
      const group = groupFor(key);
      return editors[group.representative];
    }

    function groupValue(editor) {
      return {
        includeLocations: editor.includePicker.getValue(),
        excludeLocations: editor.excludePicker.getValue(),
        utcOffsetRanges: editor.utcRanges.getValue(),
        excludeWorkTimeRanges: editor.workRanges.getValue(),
        allowUnknownLocation: editor.allowUnknown.checked,
      };
    }

    function coverageValue(editor) {
      return {
        includeLocations: editor.includePicker.getValue(),
        excludeLocations: editor.excludePicker.getValue(),
        allowUnknownLocation: editor.allowUnknown.checked,
      };
    }

    function coverageFingerprint(editor) {
      return stableDocument(coverageValue(editor));
    }

    function markCoverageStale(key) {
      const editor = activeEditorFor(key);
      if (!editor || editor.coveragePreview.hidden || !editor.coverageFingerprint) return;
      if (coverageFingerprint(editor) !== editor.coverageFingerprint) {
        editor.coverageStatus.textContent = 'Rules changed — refresh preview.';
      }
    }

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
      titlePositivePatterns.setDisabled(busy);
      titleNegative.setDisabled(busy);
      for (const [key] of ARRANGEMENTS) {
        const editor = editors[key];
        const group = groupFor(key);
        const isRepresentative = group.representative === key;
        const groupEditor = activeEditorFor(key);
        const enabled = groupEditor.enabled.checked;
        editor.enabled.disabled = rulesDisabled || !isRepresentative;
        const groupDisabled = rulesDisabled || !isRepresentative || !enabled;
        editor.includePicker.setDisabled(groupDisabled);
        editor.excludePicker.setDisabled(groupDisabled);
        editor.allowUnknown.disabled = groupDisabled;
        editor.utcRanges.setDisabled(groupDisabled);
        editor.workRanges.setDisabled(groupDisabled);
        editor.coverageButton.disabled = groupDisabled;
        if (editor.linkSelect) editor.linkSelect.disabled = rulesDisabled || !isRepresentative;
        if (editor.separateButton) editor.separateButton.disabled = rulesDisabled || !isRepresentative;
      }
      saveButton.disabled = busy || stableDocument(buildDocument()) === baseline;
    }

    function buildDocument() {
      let eligibility = null;
      if (eligibilityEnabled.checked) {
        eligibility = {};
        for (const [key] of ARRANGEMENTS) {
          const editor = activeEditorFor(key);
          if (!editor.enabled.checked) continue;
          eligibility[key] = groupValue(editor);
        }
      }
      return {
        schemaVersion: 1,
        title: {
          positive: titlePositive.getValue(),
          positivePatterns: titlePositivePatterns.getValue(),
          negative: titleNegative.getValue(),
        },
        eligibility,
      };
    }

    function syncDirty() {
      if (!saveButton) return;
      saveButton.disabled = busy || stableDocument(buildDocument()) === baseline;
    }

    function setDocument(payload, preserveLinks = false) {
      const details = new Map((payload.locationDetails || []).map((item) => [selectorKey(item), item]));
      titlePositive.setValue(payload.title?.positive || []);
      titlePositivePatterns.setValue(payload.title?.positivePatterns || []);
      titleNegative.setValue(payload.title?.negative || []);
      const eligibility = payload.eligibility;
      loadedEligibilityWasNull = eligibility == null;
      eligibilityEnabled.checked = eligibility != null;
      eligibilityPanel.hidden = eligibility == null;
      if (!preserveLinks) resetLinkGroups();

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
        editor.coverageFingerprint = null;
        editor.coveragePreview.hidden = true;
        editor.coverageStatus.textContent = '';
      }

      const missing = Array.isArray(payload.missingLocations) ? payload.missingLocations : [];
      setWarning(missing.length
        ? 'Some saved locations are no longer in the current catalog. Remove or replace the marked values before saving.'
        : '');
      baseline = stableDocument(buildDocument());
      renderLinkGroups();
      syncDisabled();
    }

    function validateBeforeSave(document) {
      const positive = new Set(document.title.positive.map((value) => value.toLowerCase()));
      const titleContradiction = document.title.negative.find(
        (value) => positive.has(value.toLowerCase()),
      );
      if (titleContradiction) {
        throw new Error(`The title term "${titleContradiction}" is both included and excluded.`);
      }

      for (const [key, label] of ARRANGEMENTS) {
        const group = document.eligibility?.[key];
        if (!group) continue;
        const includeKeys = new Set(group.includeLocations.map(selectorKey));
        const contradiction = group.excludeLocations.find((item) => includeKeys.has(selectorKey(item)));
        if (!contradiction) continue;
        const editor = activeEditorFor(key);
        const detail = [
          ...editor.includePicker.getItems(),
          ...editor.excludePicker.getItems(),
        ].find((item) => selectorKey(item) === selectorKey(contradiction));
        const locationLabel = detail?.label || detail?.displayName || contradiction.locationId;
        const groupLabel = editor.labelEl?.textContent || label;
        throw new Error(`The location "${locationLabel}" is both included and excluded for ${groupLabel}.`);
      }
    }

    function textLine(parent, text, className = '') {
      const row = document.createElement('div');
      if (className) row.className = className;
      row.textContent = text;
      parent.appendChild(row);
      return row;
    }

    function renderCoverage(editor, payload) {
      const root = editor.coveragePreview;
      root.innerHTML = '';
      root.hidden = false;
      textLine(
        root,
        'Only jobs in included or partly included places are considered. Explicit exclusions are rejected.',
        'coverage-explainer',
      );

      const includeRules = Array.isArray(payload.includeRules) ? payload.includeRules : [];
      const excludeRules = Array.isArray(payload.excludeRules) ? payload.excludeRules : [];
      textLine(
        root,
        includeRules.length
          ? `Included rules: ${includeRules.map((item) => item.label || item.displayName).join('; ')}`
          : 'Included rules: all known locations',
        'small',
      );
      textLine(
        root,
        excludeRules.length
          ? `Explicit exclusions: ${excludeRules.map((item) => item.label || item.displayName).join('; ')}`
          : 'Explicit exclusions: none',
        'small',
      );
      textLine(
        root,
        payload.allowUnknownLocation
          ? 'Unknown geography: included.'
          : 'Unknown geography: not included.',
        'small',
      );

      const counts = payload.counts || {};
      textLine(
        root,
        `Country-level view: ${counts.included || 0} included, ${counts.partial || 0} partly included, ${counts.excluded || 0} excluded.`,
        'coverage-counts small',
      );

      const regions = Array.isArray(payload.regions) ? payload.regions : [];
      if (!regions.length) {
        textLine(root, 'No known country is included by these rules.', 'coverage-empty small');
        return;
      }

      for (const region of regions) {
        const details = document.createElement('details');
        details.className = 'coverage-region';
        const summary = document.createElement('summary');
        const regionCounts = region.counts || {};
        summary.textContent = `${region.displayName} — ${regionCounts.included || 0} included, ${regionCounts.partial || 0} partial, ${regionCounts.excluded || 0} excluded`;
        details.appendChild(summary);
        const countries = document.createElement('div');
        countries.className = 'coverage-countries';
        for (const country of region.countries || []) {
          const row = document.createElement('div');
          row.className = `coverage-country coverage-${country.state}`;
          const state = document.createElement('span');
          state.className = 'coverage-state';
          state.textContent = ({
            included: '✓ Included',
            partial: '◐ Partly included',
            excluded: '✕ Excluded',
          })[country.state] || country.state;
          const name = document.createElement('strong');
          name.textContent = country.displayName;
          const heading = document.createElement('div');
          heading.className = 'coverage-country-heading';
          heading.append(state, name);
          row.appendChild(heading);
          const includedPlaces = Array.isArray(country.includedPlaces) ? country.includedPlaces : [];
          const excludedPlaces = Array.isArray(country.excludedPlaces) ? country.excludedPlaces : [];
          if (includedPlaces.length) {
            textLine(
              row,
              `Included places: ${includedPlaces.map((item) => item.label || item.displayName).join('; ')}`,
              'coverage-reason small',
            );
          }
          if (excludedPlaces.length) {
            textLine(
              row,
              `Excluded places: ${excludedPlaces.map((item) => item.label || item.displayName).join('; ')}`,
              'coverage-reason small',
            );
          }
          countries.appendChild(row);
        }
        details.appendChild(countries);
        root.appendChild(details);
      }
    }

    async function loadCoverage(key) {
      const editor = activeEditorFor(key);
      if (!editor || busy || !editor.enabled.checked) return;
      editor.coverageButton.disabled = true;
      editor.coverageStatus.textContent = 'Building preview… This can take a few seconds.';
      try {
        const current = coverageValue(editor);
        const payload = await requestJson('/ui/locations/coverage', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(current),
        });
        renderCoverage(editor, payload);
        editor.coverageFingerprint = stableDocument(current);
        editor.coverageStatus.textContent = 'Preview is based on the current unsaved rules.';
      } catch (coverageError) {
        editor.coverageStatus.textContent = coverageError.message || 'Failed to build coverage preview.';
      } finally {
        syncDisabled();
      }
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
        validateBeforeSave(document);
        const payload = await requestJson('/ui/users/discovery-preferences', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(document),
        });
        setDocument(payload, true);
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
