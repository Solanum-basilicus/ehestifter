# tests/test_url_helpers.py
from helpers.url_helpers import deduce_from_url


def _identity(url: str) -> tuple[str, str, str]:
    result = deduce_from_url(url)
    return result["provider"], result["providerTenant"], result["externalId"]


def test_successfactors_csb_extracts_numeric_id_from_german_locale_url():
    url = (
        "https://wlgore.jobs.hr.cloud.sap/job/"
        "Maschinen-und-Anlagenf%C3%BChrer-%28wmd%29/1910-de_DE"
    )

    result = deduce_from_url(url)

    assert result == {
        "provider": "successfactors",
        "providerTenant": "wlgore.jobs.hr.cloud.sap",
        "externalId": "1910",
        "foundOn": "corporate-site",
        "hiringCompanyName": "wlgore",
        "postingCompanyName": None,
    }


def test_successfactors_csb_extracts_numeric_id_from_english_locale_url():
    assert _identity(
        "https://example.jobs.hr.cloud.sap/job/Senior-Engineer/12345-en_US"
    ) == (
        "successfactors",
        "example.jobs.hr.cloud.sap",
        "12345",
    )


def test_successfactors_csb_supports_sapcloud_cn_host_family():
    assert _identity(
        "https://example.jobs.hr.sapcloud.cn/job/Senior-Engineer/12345-en_US"
    ) == (
        "successfactors",
        "example.jobs.hr.sapcloud.cn",
        "12345",
    )


def test_successfactors_csb_supports_branded_base_path():
    assert _identity(
        "https://example.jobs.hr.cloud.sap/Brand/job/Senior-Engineer/12345-en_US"
    ) == (
        "successfactors",
        "example.jobs.hr.cloud.sap",
        "12345",
    )


def test_successfactors_csb_same_slug_produces_distinct_requisition_identities():
    urls = [
        "https://wlgore.jobs.hr.cloud.sap/job/Same-Title/1910-de_DE",
        "https://wlgore.jobs.hr.cloud.sap/job/Same-Title/1911-de_DE",
        "https://wlgore.jobs.hr.cloud.sap/job/Same-Title/1954-de_DE",
    ]

    identities = [_identity(url) for url in urls]

    assert [identity[2] for identity in identities] == ["1910", "1911", "1954"]
    assert len(set(identities)) == 3


def test_successfactors_csb_repeated_submission_is_idempotent():
    url = "https://wlgore.jobs.hr.cloud.sap/job/Same-Title/1910-de_DE"

    assert deduce_from_url(url) == deduce_from_url(url)


def test_successfactors_csb_invalid_final_segment_preserves_generic_fallback():
    url = "https://wlgore.jobs.hr.cloud.sap/job/Same-Title/not-a-requisition"

    result = deduce_from_url(url)

    assert result["provider"] == "wlgore"
    assert result["providerTenant"] == ""
    assert result["externalId"] == "Same-Title"


def test_successfactors_csb_requires_job_slug_id_path_shape():
    url = "https://wlgore.jobs.hr.cloud.sap/jobs/Same-Title/1910-de_DE"

    result = deduce_from_url(url)

    assert result["provider"] == "wlgore"
    assert result["providerTenant"] == ""
    assert result["externalId"] == "1910-de_DE"
