from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any
from urllib.parse import urlparse

from bs4 import BeautifulSoup
from playwright.sync_api import Browser, Page, Playwright, sync_playwright


@dataclass(slots=True)
class ResolutionResult:
    adzuna_redirect_url: str
    final_url: str | None
    final_title: str | None
    description_text: str | None
    diagnostics: list[str]
    raw: dict[str, Any]


def _clean_text(value: str | None) -> str | None:
    if not value:
        return None
    value = re.sub(r"\s+", " ", value).strip()
    return value or None


def _extract_json_ld_description(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    for tag in soup.find_all("script", attrs={"type": "application/ld+json"}):
        raw = tag.string or tag.get_text(" ", strip=True)
        if not raw:
            continue
        try:
            payload = json.loads(raw)
        except Exception:
            continue

        candidates: list[dict[str, Any]] = []
        if isinstance(payload, dict):
            candidates = [payload]
        elif isinstance(payload, list):
            candidates = [x for x in payload if isinstance(x, dict)]

        for obj in candidates:
            obj_type = obj.get("@type")
            if obj_type in {"JobPosting", ["JobPosting"]}:
                desc = obj.get("description")
                cleaned = _clean_text(desc)
                if cleaned:
                    return cleaned
    return None


def _extract_meta_description(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")
    tag = soup.find("meta", attrs={"name": "description"})
    if tag and tag.get("content"):
        return _clean_text(tag["content"])
    tag = soup.find("meta", attrs={"property": "og:description"})
    if tag and tag.get("content"):
        return _clean_text(tag["content"])
    return None


def _extract_visible_description(html: str) -> str | None:
    soup = BeautifulSoup(html, "html.parser")

    selectors = [
        "[data-testid='job-description']",
        "[data-qa='job-description']",
        ".job-description",
        "#job-description",
        "main",
        "article",
    ]
    for selector in selectors:
        node = soup.select_one(selector)
        if not node:
            continue
        text = _clean_text(node.get_text(" ", strip=True))
        if text and len(text) >= 200:
            return text

    body = soup.body.get_text(" ", strip=True) if soup.body else None
    body = _clean_text(body)
    if body and len(body) >= 300:
        return body
    return None


def _extract_description(html: str) -> str | None:
    for extractor in (
        _extract_json_ld_description,
        _extract_meta_description,
        _extract_visible_description,
    ):
        text = extractor(html)
        if text:
            return text
    return None


def _looks_like_final_origin(current_url: str, redirect_url: str) -> bool:
    current_host = urlparse(current_url).netloc.lower()
    redirect_host = urlparse(redirect_url).netloc.lower()

    if not current_host:
        return False
    if current_host == redirect_host:
        return False
    if "adzuna." in current_host:
        return False
    return True


def _resolve_with_page(page: Page, redirect_url: str, wait_ms: int) -> ResolutionResult:
    diagnostics: list[str] = []
    page.goto(redirect_url, wait_until="domcontentloaded", timeout=60_000)

    deadline = time.time() + (wait_ms / 1000.0)
    final_origin_url: str | None = None

    while time.time() < deadline:
        page.wait_for_timeout(500)
        current = page.url
        if _looks_like_final_origin(current, redirect_url):
            final_origin_url = current
            break

    if not final_origin_url:
        current = page.url
        if _looks_like_final_origin(current, redirect_url):
            final_origin_url = current

    if not final_origin_url:
        diagnostics.append("did not observe navigation away from Adzuna detail page")

    content = page.content()
    final_title = _clean_text(page.title())
    description = _extract_description(content)
    if not description:
        diagnostics.append("could not extract full description from rendered page")

    return ResolutionResult(
        adzuna_redirect_url=redirect_url,
        final_url=final_origin_url,
        final_title=final_title,
        description_text=description,
        diagnostics=diagnostics,
        raw={
            "page_url": page.url,
            "page_title": final_title,
        },
    )


def resolve_from_adzuna_redirect(
    redirect_url: str,
    *,
    headless: bool = True,
    wait_ms: int = 15_000,
) -> ResolutionResult:
    """
    Resolve the actual origin URL and attempt to extract a fuller description
    by opening the Adzuna detail page in a real browser context.

    This is intentionally a PoC path because:
    - the standard public API docs document search/data/category/version endpoints,
    - but do not clearly expose a standard public 'job details by id' endpoint,
    - and curl/wget often hit throttling on detail pages.
    """
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=headless)
        try:
            page = browser.new_page()
            page.set_extra_http_headers(
                {
                    "Accept-Language": "en-US,en;q=0.9,de;q=0.8",
                }
            )
            return _resolve_with_page(page, redirect_url, wait_ms)
        finally:
            browser.close()