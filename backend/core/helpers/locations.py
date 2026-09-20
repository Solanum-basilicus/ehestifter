"""Core orchestration helpers for the Jobs Locations v2 catalog."""

import requests

from helpers.http import fx_post_json, jobs_base, jobs_fx_headers


def search_locations(context: dict, query: str, limit: int = 8):
    return requests.get(
        f"{jobs_base()}/jobs/locations/search",
        headers=jobs_fx_headers(context),
        params={"q": query, "limit": limit},
        timeout=10,
    )


def lookup_locations(context: dict, selectors: list[dict]):
    return fx_post_json(
        f"{jobs_base()}/jobs/locations/lookup",
        headers=jobs_fx_headers(context),
        json_body={"locations": selectors},
        timeout=15,
    )
