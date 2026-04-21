from adzuna_poc.canonical_identity import parse_canonical_identity, recover_origin_url


def test_recover_origin_url_from_redirect_query_param() -> None:
    redirect = "https://www.adzuna.de/jobs/land/ad/123456?url=https%3A%2F%2Fboards.greenhouse.io%2Facme%2Fjobs%2F987654"
    origin, diagnostics = recover_origin_url(redirect)
    assert origin == "https://boards.greenhouse.io/acme/jobs/987654"
    assert diagnostics == []


def test_parse_greenhouse_identity() -> None:
    identity, diagnostics = parse_canonical_identity("https://boards.greenhouse.io/acme/jobs/987654")
    assert diagnostics == []
    assert identity is not None
    assert identity.provider == "greenhouse"
    assert identity.provider_tenant == "acme"
    assert identity.external_id == "987654"


def test_parse_corporate_site_fallback_identity() -> None:
    identity, diagnostics = parse_canonical_identity("https://careers.example.com/open-roles/project-manager-berlin")
    assert diagnostics == []
    assert identity is not None
    assert identity.provider == "corporate-site"
    assert identity.provider_tenant == "careers.example.com"
    assert identity.external_id == "open-roles-project-manager-berlin"
