// ------------------
// -- Helpers --
// ------------------

// -- Simple, stable 32-bit FNV-1a hash -> hex (for ExternalId fallback) --
function fnv1a32Hex(str) {
  let h = 0x811c9dc5 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return ("0000000" + h.toString(16)).slice(-8);
}

function hostnameNoWww(hostname) {
  return hostname.replace(/^www\./i, "").toLowerCase();
}
function lastPathSegment(pathname) {
  const parts = pathname.split("/").filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "";
}
function firstAfter(pathname, token) {
  const parts = pathname.split("/").filter(Boolean);
  const idx = parts.findIndex(p => p.toLowerCase() === token.toLowerCase());
  if (idx >= 0 && idx + 1 < parts.length) return parts[idx + 1];
  return "";
}
function stripQuery(url) {
  return url.split("?")[0];
}
function looksLikeNumericId(seg) {
  return /^[0-9]{6,}$/.test(seg); // ≥6 digits feels safe for IDs like LinkedIn, Workday numeric refs
}
function looksLikeAlphaNumId(seg) {
  return /^[A-Za-z0-9._-]{6,}$/.test(seg);
}
function isGenericWord(seg) {
  const s = seg.toLowerCase();
  return ["jobs", "job", "position", "career", "careers", "vacancies", "vacancy", "listing", "listings", "apply"].includes(s);
}
function slugToWords(slug) {
  return slug.replace(/[-_]+/g, " ").trim();
}

// --- multi-level TLDs we should treat as a single suffix ---
const MULTI_LEVEL_TLDS = new Set([
  "co.uk","com.au","com.br","co.nz","com.sg","com.tr","com.mx","co.jp","co.kr","com.cn","com.hk","com.tw","com.pl"
]);

function getPublicSuffixLength(host) {
  const parts = host.split(".");
  if (parts.length < 2) return 1;
  const lastTwo = parts.slice(-2).join(".");
  return MULTI_LEVEL_TLDS.has(lastTwo) ? 2 : 1;
}

// Generic “jobs/career” labels in EN/FR/DACH/PL
const GENERIC_JOB_LABELS = new Set([
  // EN
  "job","jobs","career","careers",
  // DE (DACH)
  "karriere","stellen","stellenangebote","arbeit",
  // FR
  "emploi","carriere","carrieres",
  // PL
  "praca","kariera","oferty","ofertapracy","ofertypracy","oferta"
]);

// Choose the company label from host: take the label right before the public suffix,
// skipping generic job/career subdomains (jobs/career/etc.).
function companyFromHost(host) {
  const h = hostnameNoWww(host);
  const parts = h.split(".");
  const psLen = getPublicSuffixLength(h);
  const stop = parts.length - psLen - 1; // index of label before suffix

  // scan leftwards from the label right before the suffix until we find a non-generic one
  for (let i = stop; i >= 0; i--) {
    const label = (parts[i] || "").toLowerCase();
    if (label && !GENERIC_JOB_LABELS.has(label)) {
      return label;
    }
  }
  // fallback: the label right before the suffix (or first label)
  return parts[stop] || parts[0] || h;
}

// Choose provider from host when no specific ATS/board rule matched.
// Rule:
//   - Take the *left-most* label before the public suffix (e.g. bosch.newats.ai -> bosch)
//   - If that label is a generic jobs/career label (jobs, careers, karriere, ...),
//     fall back to the next one to the right (jobs.siemens.com -> siemens).
function providerFromHost(host) {
  const h = hostnameNoWww(host);
  if (!h) return "corporate-site";
  const parts = h.split(".");
  if (parts.length === 1) return parts[0];

  const psLen = getPublicSuffixLength(h);
  const cutoff = parts.length - psLen;
  if (cutoff <= 0) return parts[0];

  const pre = parts.slice(0, cutoff); // labels before suffix
  if (!pre.length) return parts[0];

  let candidate = pre[0] || "";
  if (GENERIC_JOB_LABELS.has(candidate.toLowerCase()) && pre.length > 1) {
    candidate = pre[1];
  }
  return candidate || parts[0];
}

// --- Referral source extraction from URL params ---
// Normalize a board/source name from a free-form value or a domain/URL.
function normalizeSourceName(v) {
  if (!v) return null;
  let s = String(v).trim().toLowerCase();

  // sometimes full URL is passed
  try {
    if (s.startsWith("http://") || s.startsWith("https://")) {
      const u = new URL(s);
      s = u.hostname;
    }
  } catch { /* noop */ }

  // strip www.
  s = s.replace(/^www\./, "");

  // if looks like a domain, use registrable base label
  if (s.includes(".")) {
    s = s.split(".")[0]; // simple base label
  }

  // common canonicalizations
  const map = {
    "li": "linkedin",
    "lnkd": "linkedin",
    "linkedin": "linkedin",
    "angellist": "wellfound",
    "angel": "wellfound",
    "angelco": "wellfound",
    "wellfound": "wellfound",
    "cvlibrary": "cv-library",
    "stackoverflowjobs": "stackoverflow",
    "stack-overflow": "stackoverflow",
    "stackoverflow": "stackoverflow",
    "wwr": "weworkremotely",
    "weworkremotely": "weworkremotely",
    "arbeitnow": "arbeitnow",
    "stepstone": "stepstone",
    "indeed": "indeed",
    "xing": "xing",
    "ziprecruiter": "ziprecruiter",
    "glassdoor": "glassdoor",
    "monster": "monster",
    "totaljobs": "totaljobs",
    "cv-library": "cv-library",
    "nofluffjobs": "nofluffjobs",
    "pracuj": "pracuj",
  };
  return map[s] || s;
}

// Keys that commonly carry the referral/where-we-found-it info.
// Note: we intentionally skip GH-specific "gh_src" to avoid mistaking it for a board.
const REFERRAL_KEYS = ["source", "src", "utm_source", "ref", "referrer"];

// Extract referral source from URL search params, normalized; null if none.
function sourceFromParams(u) {
  const qp = new URLSearchParams(u.search || "");
  for (const key of REFERRAL_KEYS) {
    const raw = qp.get(key);
    if (raw) {
      const norm = normalizeSourceName(raw);
      if (norm) return norm;
    }
  }
  return null;
}

// --- Which sources are ATS engines (fallback to these when no referral present) ---
const ATS_NAMES = new Set([
  "workday","greenhouse","lever","personio","smartrecruiters","teamtailor",
  "workable","jazzhr","ashby","recruitee","bamboohr","icims","jobvite",
  "breezyhr","comeet","pinpoint","join"  // + join
]);







// -- Known job boards / ATS registry --
// Each entry can implement `match(u)` and return a partial {source, externalId, company, talentAgency}.
// Opinion: keeping all patterns in one array is easier to maintain than scattered if/else.
const REGISTRY = [
  // We Work Remotely
  {
    domains: ["weworkremotely.com"],
    match: (u) => {
      const seg = lastPathSegment(u.pathname);
      const base = seg || u.pathname.split("/").filter(Boolean).pop() || "";
      const externalId = base ? fnv1a32Hex(base) : fnv1a32Hex(stripQuery(u.href));
      // Board → provider is the board, no tenant
      return { provider: "weworkremotely", providerTenant: "", externalId };
    }
  },
  // Dynamite Jobs
  {
    domains: ["dynamitejobs.com"],
    match: (u) => {
      const company = firstAfter(u.pathname, "company") || "";
      let titleSlug = firstAfter(u.pathname, "remote-job") || lastPathSegment(u.pathname);
      if (!titleSlug) titleSlug = "dynamitejobs";
      return {
        provider: "dynamitejobs",
        providerTenant: "",
        company: company || undefined,
        externalId: fnv1a32Hex(titleSlug)
      };
    }
  },
  // LinkedIn
  {
    domains: ["linkedin.com"],
    match: (u) => {
      const id = firstAfter(u.pathname, "view") || lastPathSegment(u.pathname);
      return {
        provider: "linkedin",
        providerTenant: "",
        externalId: id && looksLikeNumericId(id) ? id : fnv1a32Hex(stripQuery(u.href))
      };
    }
  },
  // Wellfound (AngelList Talent)
  {
    domains: ["wellfound.com", "angel.co"],
    match: (u) => {
      const id = firstAfter(u.pathname, "jobs") || lastPathSegment(u.pathname);
      const company = firstAfter(u.pathname, "company") || "";
      return {
        provider: "wellfound",
        providerTenant: "",
        company: company || undefined,
        externalId: id ? fnv1a32Hex(id) : fnv1a32Hex(stripQuery(u.href))
      };
    }
  },
  // Join ATS
  {
    domains: ["join.com"],
    match: (u) => {
      // Company is explicitly in the path: /companies/<company>/...
      const company = firstAfter(u.pathname, "companies") || "";
      const seg = lastPathSegment(u.pathname) || "";

      // ExternalId - prefer numeric ID prefix if present (e.g. 14702571-...)
      let externalId = seg;
      const m = /^(\d+)(?:-|$)/.exec(seg);
      if (m) {
        externalId = m[1];
      } else if (!looksLikeAlphaNumId(seg) || isGenericWord(seg)) {
        externalId = fnv1a32Hex(stripQuery(u.href));
      }

      // ATS → provider is 'join', tenant is company (like backend)
      return {
        provider: "join",
        providerTenant: company || "",
        company: company || undefined,
        externalId
      };
    }
  },
  // Remotive
  {
    domains: ["remotive.com"],
    match: (u) => {
      const id = firstAfter(u.pathname, "remote-jobs") || lastPathSegment(u.pathname);
      return { provider: "remotive", providerTenant: "", externalId: id ? fnv1a32Hex(id) : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // ZipRecruiter
  {
    domains: ["ziprecruiter.com"],
    match: (u) => {
      const id = lastPathSegment(u.pathname);
      return { provider: "ziprecruiter", providerTenant: "", externalId: id && !isGenericWord(id) ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Indeed
  {
    domains: ["indeed.com", "indeed.co.uk", "indeed.de", "indeed.fr", "indeed.nl", "indeed.es", "indeed.it", "indeed.ie", "indeed.ca"],
    match: (u) => {
      const qp = new URLSearchParams(u.search || "");
      const jk = qp.get("jk") || qp.get("vjk");
      const id = jk || lastPathSegment(u.pathname);
      return { provider: "indeed", providerTenant: "", externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // StepStone (EU)
  {
    domains: ["stepstone.de", "stepstone.fr", "stepstone.nl", "stepstone.co.uk", "stepstone.com"],
    match: (u) => {
      const id = lastPathSegment(u.pathname);
      return { provider: "stepstone", providerTenant: "", externalId: id && looksLikeAlphaNumId(id) ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Xing
  {
    domains: ["xing.com"],
    match: (u) => {
      const id = firstAfter(u.pathname, "jobs") || lastPathSegment(u.pathname);
      return { provider: "xing", providerTenant: "", externalId: id ? fnv1a32Hex(id) : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Glassdoor
  {
    domains: ["glassdoor.com", "glassdoor.de", "glassdoor.co.uk", "glassdoor.fr"],
    match: (u) => {
      const id = firstAfter(u.pathname, "job") || lastPathSegment(u.pathname);
      return { provider: "glassdoor", providerTenant: "", externalId: id && looksLikeAlphaNumId(id) ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Monster
  {
    domains: ["monster.com", "monster.de", "monster.co.uk", "monster.fr", "monster.it"],
    match: (u) => {
      const id = lastPathSegment(u.pathname);
      return { provider: "monster", providerTenant: "", externalId: id && looksLikeAlphaNumId(id) ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Workday (common in-company ATS)
  {
    domains: [/\.myworkdayjobs\.com$/i],
    match: (u) => {
      // Company often appears before domain or as subdomain.
      const host = hostnameNoWww(u.hostname);
      const company = host.split(".")[0]; // e.g., azenta.wd1.myworkdayjobs.com -> "azenta"
      // ID often after last slash; sometimes like _R20250574
      const seg = lastPathSegment(u.pathname);
      const id = seg && !isGenericWord(seg) ? seg : fnv1a32Hex(stripQuery(u.href));
      // ATS: provider fixed, tenant = company
      return { provider: "workday", providerTenant: company || "", company, externalId: id };
    }
  },
  // Greenhouse
  {
    domains: ["boards.greenhouse.io", "greenhouse.io"],
    match: (u) => {
      const company = firstAfter(u.pathname, "boards") || "";
      const id = firstAfter(u.pathname, "jobs") || lastPathSegment(u.pathname);
      return {
        provider: "greenhouse",
        providerTenant: company || "",
        company: company || undefined,
        externalId: id && looksLikeNumericId(id) ? id : fnv1a32Hex(stripQuery(u.href))
      };
    }
  },
  // Lever
  {
    domains: [/\.lever\.co$/i],
    match: (u) => {
      const host = hostnameNoWww(u.hostname).replace(".lever.co","");
      const company = host || "";
      const id = firstAfter(u.pathname, "jobs") || lastPathSegment(u.pathname);
      return {
        provider: "lever",
        providerTenant: company || "",
        company: company || undefined,
        externalId: id ? id : fnv1a32Hex(stripQuery(u.href))
      };
    }
  },
  // Personio
  {
    domains: [/\.jobs\.personio\.de$/i, /\.jobs\.personio\.com$/i],
    match: (u) => {
      const host = hostnameNoWww(u.hostname).split(".")[0];
      const company = host || "";
      const id = lastPathSegment(u.pathname);
      return {
        provider: "personio",
        providerTenant: company || "",
        company,
        externalId: id && looksLikeAlphaNumId(id) ? id : fnv1a32Hex(stripQuery(u.href))
      };
    }
  },
  // SmartRecruiters
  {
    domains: ["careers.smartrecruiters.com", "jobs.smartrecruiters.com"],
    match: (u) => {
      const company = firstAfter(u.pathname, "SmartRecruiters") || firstAfter(u.pathname, "company") || "";
      const id = firstAfter(u.pathname, "job") || lastPathSegment(u.pathname);
      return {
        provider: "smartrecruiters",
        providerTenant: company || "",
        company: company || undefined,
        externalId: id ? id : fnv1a32Hex(stripQuery(u.href))
      };
    }
  },
  // Teamtailor
  {
    domains: [/\.teamtailor\.com$/i],
    match: (u) => {
      const company = hostnameNoWww(u.hostname).split(".")[0];
      const id = lastPathSegment(u.pathname);
      return { provider: "teamtailor", providerTenant: company || "", company, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Workable
  {
    domains: [/\.applytojob\.com$/i, /\.workable\.com$/i],
    match: (u) => {
      const id = lastPathSegment(u.pathname);
      const host = hostnameNoWww(u.hostname);
      const company = host.includes(".workable.com") ? host.split(".")[0] : host.includes(".applytojob.com") ? "" : undefined;
      // For applytojob.com we don't always have a tenant; leave tenant empty to mirror backend mapping
      return { provider: "workable", providerTenant: company || "", company: company || undefined, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // JazzHR
  {
    // Align with backend: JazzHR only on jazz.co (applytojob.com is handled by Workable)
    domains: [/\.jazz\.co$/i],
    match: (u) => {
      const id = lastPathSegment(u.pathname);
      const company = hostnameNoWww(u.hostname).split(".")[0];
      return { provider: "jazzhr", providerTenant: company || "", company, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Ashby
  {
    domains: [/\.ashbyhq\.com$/i],
    match: (u) => {
      const company = hostnameNoWww(u.hostname).split(".")[0];
      const id = lastPathSegment(u.pathname);
      return { provider: "ashby", providerTenant: company || "", company, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Recruitee
  {
    domains: [/\.recruitee\.com$/i],
    match: (u) => {
      const company = hostnameNoWww(u.hostname).split(".")[0];
      const id = lastPathSegment(u.pathname);
      return { provider: "recruitee", providerTenant: company || "", company, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // BambooHR
  {
    domains: [/\.bamboohr\.com$/i],
    match: (u) => {
      const company = hostnameNoWww(u.hostname).split(".")[0];
      const id = lastPathSegment(u.pathname);
      return { provider: "bamboohr", providerTenant: company || "", company, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // iCIMS
  {
    domains: ["careers.icims.com", "icims.com"],
    match: (u) => {
      const id = firstAfter(u.pathname, "jobs") || lastPathSegment(u.pathname);
      return { provider: "icims", providerTenant: "", externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Jobvite
  {
    domains: [/\.jobvite\.com$/i],
    match: (u) => {
      const id = lastPathSegment(u.pathname);
      const company = hostnameNoWww(u.hostname).split(".")[0];
      // Some tenants appear as subdomain; fallback to empty if not present
      const tenant = company && company !== "jobvite" ? company : "";
      return { provider: "jobvite", providerTenant: tenant, company: tenant || undefined, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // BreezyHR
  {
    domains: [/\.breezy\.hr$/i],
    match: (u) => {
      const company = hostnameNoWww(u.hostname).split(".")[0];
      const id = lastPathSegment(u.pathname);
      return { provider: "breezyhr", providerTenant: company || "", company, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Comeet
  {
    domains: [/\.comeet\.co$/i],
    match: (u) => {
      const id = lastPathSegment(u.pathname);
      const company = hostnameNoWww(u.hostname).split(".")[0];
      return { provider: "comeet", providerTenant: company || "", company, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Pinpoint
  {
    domains: [/\.pinpoint\.jobs$/i],
    match: (u) => {
      const company = hostnameNoWww(u.hostname).split(".")[0];
      const id = lastPathSegment(u.pathname);
      return { provider: "pinpoint", providerTenant: company || "", company, externalId: id ? id : fnv1a32Hex(stripQuery(u.href)) };
    }
  },
  // Job boards UK/EU
  {
    domains: ["reed.co.uk"],
    match: (u) => ({ provider: "reed", providerTenant: "", externalId: lastPathSegment(u.pathname) || fnv1a32Hex(stripQuery(u.href)) })
  },
  {
    domains: ["totaljobs.com", "totaljobs.com.au", "cwjobs.co.uk"],
    match: (u) => ({ provider: "totaljobs", providerTenant: "", externalId: lastPathSegment(u.pathname) || fnv1a32Hex(stripQuery(u.href)) })
  },
  {
    domains: ["cv-library.co.uk"],
    match: (u) => ({ provider: "cv-library", providerTenant: "", externalId: lastPathSegment(u.pathname) || fnv1a32Hex(stripQuery(u.href)) })
  },
  {
    domains: ["nofluffjobs.com"],
    match: (u) => ({ provider: "nofluffjobs", providerTenant: "", externalId: lastPathSegment(u.pathname) || fnv1a32Hex(stripQuery(u.href)) })
  },
  {
    domains: ["pracuj.pl"],
    match: (u) => ({ provider: "pracuj", providerTenant: "", externalId: lastPathSegment(u.pathname) || fnv1a32Hex(stripQuery(u.href)) })
  }
];

// -- Talent agencies (recognize by domain; can set talentAgency/company) --
const TALENT_AGENCIES = [
  "adecco.com", "randstad.com", "manpowergroup.com", "hays.com",
  "tietalent.com", "aerotek.com", "pagepersonnel.com", "michaelpage.com",
  "robertwalters.com", "kornferry.com", "reedglobal.com", "alfredtalke.com"
].map(d => d.toLowerCase());

// -- Core: deduce fields from URL --
// Returns new-API keys and (for now) legacy aliases.
export function deduceFromUrl(rawUrl) {
  let url;
  try { url = new URL(rawUrl); } catch { return {}; }

  const host = hostnameNoWww(url.hostname);

  // Talent agency by domain (posting company)
  const agencyHit = TALENT_AGENCIES.find(d => host.endsWith(d));
  const postingCompanyName = agencyHit ? agencyHit.split(".")[0] : undefined;

  // Potential referral source (where we *found* the job)
  const referral = (sourceFromParams(url) || "").toLowerCase();

  // Try known registry first (ATS / boards with custom extractors)
  for (const entry of REGISTRY) {
    const hit = (entry.domains || []).some(d => {
      if (typeof d === "string") return host === d || host.endsWith("." + d);
      if (d instanceof RegExp)   return d.test(host);
      return false;
    });
    if (!hit) continue;

    // r may contain legacy fields like: { source, company, externalId, title, tenant, provider, ... }
    const r = entry.match(url) || {};

    // Provider: prefer explicit, else legacy source from registry
    let provider = (r.provider || r.source || "").toLowerCase() || "corporate-site";

    // FoundOn: if we are on ATS and referral exists -> use referral; else fall back
    // If it's *not* ATS (i.e., a job board), treat provider as foundOn too.
    let foundOn;
    if (ATS_NAMES.has(provider)) {
      foundOn = referral || "corporate-site";
    } else {
      // Boards and others: if no explicit referral, the board itself is where we found it
      foundOn = referral || provider || "corporate-site";
    }

    // Tenant: prefer explicit tenant, else r.company (tenants often equal company/slug on ATS),
    // else infer from registrable host label.
    let providerTenant = (r.providerTenant || r.tenant || "");
    if (!providerTenant && ATS_NAMES.has(provider)) {
      providerTenant = (r.company || companyFromHost(host) || "");
    }

    // Hiring company: prefer explicit; else r.company; else infer from registrable domain
    // (but don't infer from agency domains)
    let hiringCompanyName = (r.hiringCompanyName || r.company);
    if (!hiringCompanyName && !agencyHit) {
      hiringCompanyName = companyFromHost(host);
    }

    // External id
    let externalId = r.externalId;
    if (!externalId) {
      // fallback: last segment or a stable hash of the URL (w/o query)
      const seg = lastPathSegment(url.pathname);
      externalId = seg || fnv1a32Hex(stripQuery(url.href));
    }

    // If we recognized agency from host and the extractor didn't set a talent agency, keep it
    const postingName = r.postingCompanyName || r.talentAgency || postingCompanyName;

    // Return new API keys + temporary legacy aliases
    return {
      foundOn,
      provider,
      providerTenant,
      externalId,
      hiringCompanyName,
      postingCompanyName: postingName || undefined,

      // legacy aliases (keep for now; safe to remove later)
      source: foundOn,
      company: hiringCompanyName,
      talentAgency: postingName || undefined,

      // passthrough if the registry gave us one (UI might use it)
      title: r.title
    };
  }

  // -------- No registry match: generic fallback ----------
  const STOP_WORDS = new Set(["job","jobs","position","positions","career","careers"]);
  const afterJob = firstAfter(url.pathname, "job");
  let externalId;
  if (afterJob) {
    externalId = afterJob;
  } else {
    const last = lastPathSegment(url.pathname);
    externalId = (last && !STOP_WORDS.has(last.toLowerCase())) ? last : fnv1a32Hex(stripQuery(url.href));
  }

  // Provider from host; Tenant unknown; FoundOn prefers referral param
  const provider = providerFromHost(host);
  const providerTenant = "";
  const foundOn = referral || "corporate-site";

  // Hiring company from host (skip if it’s an agency domain)
  const hiringCompanyName = agencyHit ? undefined : companyFromHost(host);
  const postingName = postingCompanyName;

  return {
    foundOn,
    provider,
    providerTenant,
    externalId,
    hiringCompanyName,
    postingCompanyName: postingName || undefined,

    // legacy aliases
    source: foundOn,
    company: hiringCompanyName,
    talentAgency: postingName || undefined
  };
}

