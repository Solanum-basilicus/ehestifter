// Shared init for create/edit pages
// Requires: quill.min.js, job-url-helpers.js, location-picker.js, and window.__JOB_FORM_CTX__
// Exports: window.initJobForm(opts)

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

  function hydrateFromInitial(initial, quill, locApi) {
    // text inputs
    const assign = (id, v) => { if (v) el(id).value = v; };
    assign('url', initial.url);
    assign('title', initial.title);
    assign('hiringCompanyName', initial.hiringCompanyName);
    assign('postingCompanyName', initial.postingCompanyName);
    assign('foundOn', initial.foundOn);
    assign('atsVendor', initial.atsVendor);
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
    if (radio) radio.checked = true;

    // description
    if (initial.descriptionHtml) {
      quill.root.innerHTML = initial.descriptionHtml;
    } else if (initial.description) {
      // fallback if server passes plain html under 'description'
      quill.root.innerHTML = initial.description;
    }

    const details = new Map(
      (initial.locationDetails || [])
        .filter(item => item && typeof item === 'object')
        .map(item => [window.locationSelectorKey(item), item])
    );
    locApi.setValue(initial.locationsV2 || [], details);
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
    const atsVendorInput = el('atsVendor');
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

    const locationNotice = el('locationNotice');
    const locApi = new window.LocationPicker(el('locations'), {
      onChange: updateLocationNotice,
    });

    function updateLocationNotice() {
      const items = locApi.getItems();
      let message = '';
      if (items.some(item => item.stale)) {
        message = ctx.initial?.locationLookupFailed
          ? 'Location labels could not be loaded. Stored location IDs are kept.'
          : 'Some stored locations are not in the current catalog. Their IDs are kept.';
      } else if (mode === 'edit' && !items.length) {
        message = 'No canonical location is stored for this job.';
      }
      locationNotice.textContent = message;
      locationNotice.hidden = !message;
    }

    // Nuggets
    document.getElementById('foundOnNuggets')?.addEventListener('click', (e) => {
      const t = e.target;
      if (t.classList.contains('nugget')) {
        foundOnInput.value = t.textContent.trim();
        foundOnInput.dispatchEvent(new Event('change'));
      }
    });

    // URL identity: Jobs domain is authoritative.
    let lastIdentityRequestUrl = "";
    let identitySeq = 0;
    let companyTouchedByUser = false;
    let companyAutofilledFromIdentity = false;

    const debounce = (fn, ms = 400) => {
      let t;
      return (...args) => {
        clearTimeout(t);
        t = setTimeout(() => fn(...args), ms);
      };
    };

    function renderDuplicateBanner(state) {
      const banner = document.querySelector('#dupBanner');
      if (!banner) return;

      if (!state || !state.exists || !state.id) {
        banner.classList.remove('show');
        banner.textContent = '';
        return;
      }

      const id = state.id;
      const uiHref = `/jobs/${encodeURIComponent(id)}`;
      banner.innerHTML = `Already in your tracker. <a href="${uiHref}">Open job →</a>`;
      banner.classList.add('show');
    }

    function applyIdentityResponse(data) {
      if (!data || typeof data !== 'object') return;

      const foundOn = data.foundOn;
      const provider = data.provider;
      const tenant = data.providerTenant;
      const externalId = data.externalId;

      if (foundOn) foundOnInput.value = foundOn;

      if (!disableAts) {
        if (provider) providerInput.value = provider;
        if (tenant !== undefined && tenant !== null) tenantInput.value = tenant;
        if (externalId) externalIdInput.value = externalId;
      }

      const company = tenant || '';
      if (company && (!companyInput.value.trim() || (companyAutofilledFromIdentity && !companyTouchedByUser))) {
        companyInput.value = company;
        companyAutofilledFromIdentity = true;
      }

      renderDuplicateBanner(data);
    }

    companyInput.addEventListener('input', () => {
      companyTouchedByUser = true;
      companyAutofilledFromIdentity = false;
    });

    async function checkIdentityFromUrl({ force = false } = {}) {
      if (mode !== 'create') return;

      const raw = urlInput.value.trim();
      if (!raw) {
        lastIdentityRequestUrl = '';
        renderDuplicateBanner(null);
        return;
      }

      if (!force && raw === lastIdentityRequestUrl) return;

      lastIdentityRequestUrl = raw;
      const seq = ++identitySeq;

      const params = new URLSearchParams({ url: raw });

      try {
        const res = await fetch(`/ui/jobs/exists?${params.toString()}`, {
          method: 'GET',
          headers: { 'Accept': 'application/json' },
          credentials: 'same-origin',
        });

        if (seq !== identitySeq || urlInput.value.trim() !== raw) return;

        if (!res.ok) {
          renderDuplicateBanner(null);
          return;
        }

        const body = await res.json();
        applyIdentityResponse(body);
      } catch {
        if (seq === identitySeq) renderDuplicateBanner(null);
      }
    }

    const checkIdentityFromUrlDebounced = debounce(() => checkIdentityFromUrl(), 400);

    urlInput.addEventListener('input', checkIdentityFromUrlDebounced);
    urlInput.addEventListener('paste', () => setTimeout(checkIdentityFromUrlDebounced, 0));
    urlInput.addEventListener('change', checkIdentityFromUrlDebounced);
    urlInput.addEventListener('blur', () => {
      const raw = urlInput.value.trim();
      if (raw && raw !== lastIdentityRequestUrl) {
        checkIdentityFromUrl({ force: true });
      }
    });

    // Load edit values after the editors are ready.
    const initial = ctx.initial || {};
    if (mode === 'edit') {
      // hydrate even if id is missing, as long as we have *any* fields
      const hasSomething = initial && (initial.id || initial.url || initial.title || initial.hiringCompanyName || (initial.locationsV2||[]).length || initial.descriptionHtml);
      if (hasSomething) {
        hydrateFromInitial(initial, quill, locApi);
      }
    }

    updateLocationNotice();

    function setSubmitting(on) {
      locApi.setDisabled(on);
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
        atsVendor: atsVendorInput.value.trim() || undefined,
        remoteType: normRemote(document.querySelector('input[name="remoteType"]:checked')?.value || 'Unknown'),
        description,
        locationsV2: locApi.getValue()
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
