from __future__ import annotations

import requests


def test_dispatch_run_requires_scheduler_or_operator(
    base_url,
    jobs_headers,
    operator_headers,
):
    r_forbidden = requests.post(
        f"{base_url}/analytics/dispatch/run",
        headers=jobs_headers,
        timeout=10,
    )
    print("DISPATCH with jobs key:", r_forbidden.status_code, r_forbidden.text)
    assert r_forbidden.status_code == 403, r_forbidden.text

    r_ok = requests.post(
        f"{base_url}/analytics/dispatch/run",
        headers=operator_headers,
        timeout=20,
    )
    print("DISPATCH with operator key:", r_ok.status_code, r_ok.text)
    assert r_ok.status_code == 200, r_ok.text

    body = r_ok.json()
    for key in ("attempted", "sent", "retry", "dead", "skipped", "exportEnabled"):
        assert key in body, body
        