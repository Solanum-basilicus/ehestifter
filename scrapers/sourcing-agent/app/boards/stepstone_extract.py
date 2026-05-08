STEPSTONE_VISIBLE_CARDS_JS = r"""
(() => {
  const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

  const isVisible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const style = window.getComputedStyle(el);
    return r.width > 0 && r.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  };

  const cards = [];
  const articles = Array.from(document.querySelectorAll('article[data-testid="job-item"]'));

  for (const article of articles) {
    if (!isVisible(article)) continue;

    const titleLink = article.querySelector('a[data-testid="job-item-title"][href]');
    if (!titleLink) continue;

    const href = titleLink.getAttribute("href");
    if (!href || !href.includes("/stellenangebote--")) continue;

    const detailUrl = new URL(href, location.origin).href;
    const title = clean(titleLink.innerText || titleLink.textContent);
    const company = clean(article.querySelector('[data-at="job-item-company-name"]')?.innerText);
    const locationText = clean(article.querySelector('[data-at="job-item-location"]')?.innerText);

    if (!title) continue;

    cards.push({
      ordinal: cards.length + 1,
      title,
      company: company || null,
      location_text: locationText || null,
      detail_url: detailUrl,
      evidence: clean(article.innerText).slice(0, 500),
      open_instruction: `open detail_url ${detailUrl}`
    });

    if (cards.length >= 10) break;
  }

  return {
    source: "stepstone",
    cards,
    warnings: cards.length ? [] : ["No visible StepStone job-item cards found."]
  };
})()
"""
STEPSTONE_DETAIL_TEXT_JS = r"""
(() => {
  const clean = (s) => (s || "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

  const title =
    document.querySelector('h1')?.innerText ||
    document.title ||
    null;

  const bodyText = clean(document.body.innerText);

  return {
    url: location.href,
    title: clean(title),
    page_title: document.title,
    text: bodyText
  };
})()
"""
STEPSTONE_IS_SEARCH_RESULTS_PAGE_JS = r"""
(() => {
  const url = location.href;
  const hasSearchUrl = url.startsWith("https://www.stepstone.de/jobs/");
  const hasUnifiedResultList = !!document.querySelector('[data-at="unified-resultlist"]');
  const hasJobItems = document.querySelectorAll('article[data-testid="job-item"]').length > 0;

  return {
    ok: hasSearchUrl && hasUnifiedResultList && hasJobItems,
    url,
    hasSearchUrl,
    hasUnifiedResultList,
    jobItemCount: document.querySelectorAll('article[data-testid="job-item"]').length
  };
})()
"""