// Shared init for create/edit pages
// Requires: quill.min.js, job-url-helpers.js, geo-dict.js, and a bootstrap window.__JOB_FORM_CTX__
// Exports: window.initJobForm(opts)
import { deduceFromUrl } from "/static/js/job-url-helpers.js";
import { loadGeoDict, countryLookup, prioritizedCountries, citiesByCountry } from "/static/js/geo-dict.js";

(function(){
  const DESC_LIMIT = 20000;

  function el(id) { return document.getElementById(id); }

  function sanitizeClientHtml(html) {
    try {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const removeAll = (sel) => doc.querySelectorAll(sel).forEach(n => n.remove());
      removeAll('script,style,iframe,object,embed,video,audio,canvas,svg,img');
      doc.querySelectorAll('*').forEach(el => {
        [...el.attributes].forEach(a => {
          if (a.name.toLowerCase().startsWith('on')) el.removeAttribute(a.name);
        });
        if (el.tagName.toLowerCase() === 'a') {
          const href = (el.getAttribute('href') || '').trim();
          if (!/^https?:\/\//i.test(href) && !/^mailto:/i.test(href)) el.removeAttribute('href');
          el.setAttribute('target', '_blank');
          el.setAttribute('rel', 'noopener noreferrer nofollow');
        }
      });
      const allowed = new Set(['p','br','hr','span','div','b','strong','i','em','u','code','pre','blockquote',
                               'ul','ol','li','h1','h2','h3','h4','a']);
      doc.body.querySelectorAll('*').forEach(node => {
        if (!allowed.has(node.tagName.toLowerCase())) {
          const parent = node.parentNode;
          while (node.firstChild) parent.insertBefore(node.firstChild, node);
          parent.removeChild(node);
        }
      });
      const cleaned = doc.body.innerHTML
        .replace(/^\s+|\s+$/g, '')
        .replace(/<p><br><\/p>/g, '')
        .trim();
      return cleaned || '';
    } catch {
      return '';
    }
  }

  function cityDatalistId(cc) { return `cities_${cc}`; }

  function attachLocationsEditor(locHost) {
    function addLocRow(init = {}) {
      const row = document.createElement('div');
      row.className = 'loc-row';
      row.innerHTML = `
        <input type="text" class="country" placeholder="Country" list="countriesList" value="${init.countryName || ''}">
        <input type="text" class="city" placeholder="City (optional)" value="${init.cityName || ''}" list="">
        <button type="button" class="btn" data-act="del" aria-label="Remove location" title="Remove">✕</button>
      `;
      row.querySelector('[data-act="del"]').addEventListener('click', () => row.remove());
      const countryInput = row.querySelector('.country');
      const cityInput = row.querySelector('.city');

      const ccInit = (init.countryCode || '').toUpperCase();
      const countryObj =
        (ccInit && countryLookup(ccInit)) ||
        (init.countryName && countryLookup(init.countryName)) || null;

      function refreshCities() {
        const m = countryLookup(countryInput.value);
        const currentCC = (m?.code || '').toUpperCase();
        const listId = cityDatalistId(currentCC || 'NONE');
        let listEl = document.getElementById(listId);
        if (!listEl) {
          listEl = document.createElement('datalist');
          listEl.id = listId;
          document.body.appendChild(listEl);
        }
        const cities = citiesByCountry(currentCC);
        listEl.innerHTML = cities.map(c => `<option value="${c}"></option>`).join('');
        cityInput.setAttribute('list', listId);
      }

      function setCountryConfirmed(c) {
        countryInput.value = c.name;
        cityInput.value = '';
        refreshCities();
      }
      function clearCountryTransient() {
        cityInput.value = '';
        refreshCities();
      }

      countryInput.addEventListener('input', () => {
        if (!countryInput.value.trim()) {
          clearCountryTransient();
          return;
        }
        clearCountryTransient();
      });
      countryInput.addEventListener('keydown', (e) => {
        if (e.key === 'Tab' && !e.shiftKey) {
          const val = countryInput.value.trim();
          const exact = countryLookup(val);
          if (exact) { setCountryConfirmed(exact); return; }
          const matches = window.countryMatches
            ? window.countryMatches(val)
            : prioritizedCountries().filter(x =>
                x.name.toLowerCase().startsWith(val.toLowerCase()) ||
                x.code.toLowerCase().startsWith(val.toLowerCase()));
          if (matches.length === 1) setCountryConfirmed(matches[0]);
        }
      });
      function confirmOnResolve() {
        const m = countryLookup(countryInput.value);
        if (m) setCountryConfirmed(m);
        else clearCountryTransient();
      }
      countryInput.addEventListener('change', confirmOnResolve);
      countryInput.addEventListener('blur', confirmOnResolve);

      if (countryObj) setCountryConfirmed(countryObj);
      else if (ccInit) refreshCities();

      locHost.appendChild(row);
    }

    function readLocations() {
      const rows = [...locHost.querySelectorAll('.loc-row')];
      const out = [];
      for (const r of rows) {
        const countryDisplay = r.querySelector('.country').value.trim();
        const city = r.querySelector('.city').value.trim();
        const cm = countryLookup(countryDisplay);
        const cn = cm ? cm.name : (countryDisplay || '');
        const code = cm ? cm.code : null;
        if (!cn && !code && !city) continue;
        out.push({ countryName: cn || '', countryCode: code || null, cityName: city || null });
      }
      return out;
    }

    return { addLocRow, readLocations };
  }

  async function hydrateFromInitial(initial, quill, locApi) {
    // text inputs
    const assign = (id, v) => { if (v) el(id).value = v; };
    assign('url', initial.url);
    assign('title', initial.title);
    assign('hiringCompanyName', initial.hiringCompanyName);
    assign('postingCompanyName', initial.postingCompanyName);
    assign('foundOn', initial.foundOn);
    assign('provider', initial.provider);
    assign('providerTenant', initial.providerTenant);
    assign('externalId', initial.externalId);

    // radio (normalize common variants)
    const normRT = (v) => {
      const t = String(v || '').trim().toLowerCase();
      if (t === 'remote') return 'Remote';
      if (t === 'hybrid') return 'Hybrid';
      if (t === 'onsite' || t === 'on-site' || t === 'on site') return 'On-Site';
      return 'Unknown';
    };
    const rt = normRT(initial.remoteType || 'Unknown');
    const radio = document.querySelector(`input[name="remoteType"][value="${rt}"]`)
                || document.querySelector('input[name="remoteType"][value="Unknown"]');

    // description
    if (initial.descriptionHtml) {
      quill.root.innerHTML = initial.descriptionHtml;
    } else if (initial.description) {
      // fallback if server passes plain html under 'description'
      quill.root.innerHTML = initial.description;
    }

    // locations
    const locs = Array.isArray(initial.locations) ? initial.locations : [];
    if (locs.length) {
      // clear the default empty row
      document.querySelectorAll('#locations .loc-row').forEach(n => n.remove());
      for (const L of locs) locApi.addLocRow(L);
    }
  }

  async function initJobForm(opts) {
    // Be robust: if global isn’t set, parse the JSON block ourselves.
    let ctx = window.__JOB_FORM_CTX__;
    if (!ctx) {
      const blk = document.getElementById('job-form-data');
      if (blk) {
        try { ctx = JSON.parse(blk.textContent); } catch(_) {}
      }
    }
    ctx = ctx || { mode: 'create', initial: {}, disableAts: false };
    const mode = opts?.mode || ctx.mode || 'create';
    const disableAts = !!(opts?.disableAts ?? ctx.disableAts);

    const btnSubmit = el('btnSubmit');
    const btnCancel = el('btnCancel');
    const errEl = el('err');
    const urlInput = el('url');
    const foundOnInput = el('foundOn');
    const externalIdInput = el('externalId');
    const companyInput = el('hiringCompanyName');
    const providerInput = el('provider');
    const tenantInput = el('providerTenant');
    const titleInput = el('title');

    // Quill
    const quill = new Quill('#descEditor', { theme: 'snow', modules: { toolbar: '#descToolbar' } });
    const Delta = Quill.import('delta');
    quill.clipboard.addMatcher('img', () => new Delta());
    const descCountEl = el('descCount');
    function updateDescCount() {
      const len = quill.getText().trimEnd().length;
      descCountEl.textContent = String(len);
      descCountEl.classList.toggle('over', len > DESC_LIMIT);
    }
    quill.on('text-change', updateDescCount);
    updateDescCount();

    // Disable ATS if requested
    if (disableAts) {
      ['provider','providerTenant','externalId'].forEach(id => {
        const input = el(id);
        if (input) input.setAttribute('disabled','true');
      });
    }

    // Geo dict bootstrap
    const countriesList = document.createElement('datalist');
    countriesList.id = 'countriesList';
    document.body.appendChild(countriesList);
    await loadGeoDict();
    countriesList.innerHTML = prioritizedCountries().map(c => `<option value="${c.name}"></option>`).join('');

    const locHost = el('locations');
    const locApi = attachLocationsEditor(locHost);
    // at least one row
    locApi.addLocRow();

    // Nuggets
    document.getElementById('foundOnNuggets')?.addEventListener('click', (e) => {
      const t = e.target;
      if (t.classList.contains('nugget')) {
        foundOnInput.value = t.textContent.trim();
        foundOnInput.dispatchEvent(new Event('change'));
      }
    });

    // URL helpers
    urlInput.addEventListener('blur', () => {
      const raw = urlInput.value.trim();
      if (!raw) return;
      const d = deduceFromUrl(raw) || {};
      const foundOn = d.foundOn || d.source;
      const extId = d.externalId || d.ExternalId;
      const company = d.hiringCompanyName || d.company;
      const provider = d.provider || null;
      const tenant = d.providerTenant || d.tenant || null;
      const title = d.title || null;

      if (foundOn && !foundOnInput.value.trim()) foundOnInput.value = foundOn;
      if (!disableAts && extId && !externalIdInput.value.trim()) externalIdInput.value = extId;
      if (company && !companyInput.value.trim()) companyInput.value = company;
      if (!disableAts && provider && !providerInput.value.trim()) providerInput.value = provider;
      if (!disableAts && tenant && !tenantInput.value.trim()) tenantInput.value = tenant;
      if (title && !titleInput.value.trim()) titleInput.value = title;
    });

    // hydrate initial (edit) after Quill + geo ready
    const initial = ctx.initial || {};
    if (mode === 'edit') {
      // hydrate even if id is missing, as long as we have *any* fields
      const hasSomething = initial && (initial.id || initial.url || initial.title || initial.hiringCompanyName || (initial.locations||[]).length || initial.descriptionHtml);
      if (hasSomething) {
        await hydrateFromInitial(initial, quill, locApi);
      }
    }

    function setSubmitting(on) {
      if (on) {
        btnSubmit.setAttribute('disabled','true');
        btnSubmit.textContent = (mode === 'edit') ? 'Saving…' : 'Creating…';
        btnCancel.setAttribute('aria-disabled','true');
      } else {
        btnSubmit.removeAttribute('disabled');
        btnSubmit.textContent = (mode === 'edit') ? 'Save changes' : 'Create';
        btnCancel.removeAttribute('aria-disabled');
      }
    }
    btnCancel.addEventListener('click', (e) => {
      if (btnCancel.getAttribute('aria-disabled') === 'true') e.preventDefault();
    });

    async function doSubmit() {
      errEl.classList.add('hidden');
      errEl.textContent = '';

      const url = urlInput.value.trim();
      if (!url) {
        errEl.textContent = 'URL is required.';
        errEl.classList.remove('hidden');
        urlInput.focus();
        return;
      }
      const plain = quill.getText().trim();
      const htmlRaw = quill.root.innerHTML.trim();
      if (plain.length > DESC_LIMIT) {
        errEl.textContent = `Description is too long (${plain.length} > ${DESC_LIMIT} characters).`;
        errEl.classList.remove('hidden');
        return;
      }
      const htmlSafe = sanitizeClientHtml(htmlRaw);
      const description = plain ? htmlSafe : undefined;

      // Normalize remoteType to our radio values: Remote | Hybrid | On-Site | Unknown
      const normRemote = (v) => {
        const t = String(v || '').trim().toLowerCase();
        if (t === 'remote') return 'Remote';
        if (t === 'hybrid') return 'Hybrid';
        if (t === 'onsite' || t === 'on-site' || t === 'on site') return 'On-Site';
        return 'Unknown';
      };      

      const body = {
        url,
        title: titleInput.value.trim() || undefined,
        hiringCompanyName: companyInput.value.trim() || undefined,
        postingCompanyName: el('postingCompanyName').value.trim() || undefined,
        foundOn: foundOnInput.value.trim() || undefined,
        remoteType: normRemote(document.querySelector('input[name="remoteType"]:checked')?.value || 'Unknown'),
        description,
        locations: (function(){
          const L = locApi.readLocations();
          return L.length ? L : undefined;
        })()
      };
      if (!disableAts) {
        body.provider = providerInput.value.trim() || undefined;
        body.providerTenant = tenantInput.value.trim() || undefined;
        body.externalId = externalIdInput.value.trim() || undefined;
      }

      setSubmitting(true);
      try {
        const resp = await fetch(opts.submitUrl, {
          method: opts.method || (mode === 'edit' ? 'PUT' : 'POST'),
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify(body)
        });
        if (!resp.ok) {
          const tx = await resp.text();
          throw new Error(tx || `HTTP ${resp.status}`);
        }
        const data = await resp.json().catch(()=> ({}));
        // redirect:
        const id = data.id || initial.id;
        if (id) window.location.assign(`/jobs/${encodeURIComponent(id)}`);
        else window.history.back(); // fallback
      } catch (err) {
        errEl.textContent = `${mode === 'edit' ? 'Save failed' : 'Create failed'}: ${err.message || err}`;
        errEl.classList.remove('hidden');
        setSubmitting(false);
      }
    }

    document.getElementById('btnSubmit').addEventListener('click', (e) => {
      e.preventDefault();
      doSubmit();
    });
  }

  window.initJobForm = initJobForm;
})();
