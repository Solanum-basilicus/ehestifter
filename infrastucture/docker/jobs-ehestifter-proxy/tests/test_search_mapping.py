from __future__ import annotations

from uuid import UUID

from ehjobs_proxy.upstream_jobs import _to_search_item


def test_search_mapping_accepts_pascal_case_jobs_dto():
    item = _to_search_item(
        {
            "Id": "c49958ad-10f4-4b01-a629-f52a3f4d10b0",
            "Title": "Product Manager - Interfaces",
            "HiringCompanyName": "Supabase",
            "CurrentStatus": "Applied",
            "Provider": "ashby",
            "ProviderTenant": "jobs",
            "ExternalId": "184c3ad5-5d5f-44a1-98f7-65ff6f287b2f",
            "Url": "https://jobs.ashbyhq.com/supabase/184c3ad5-5d5f-44a1-98f7-65ff6f287b2f",
        }
    )

    assert item.jobId == UUID("c49958ad-10f4-4b01-a629-f52a3f4d10b0")
    assert item.title == "Product Manager - Interfaces"
    assert item.company == "Supabase"
    assert item.status == "Applied"
    assert item.provider == "ashby"
    assert item.providerTenant == "jobs"
    assert item.externalId == "184c3ad5-5d5f-44a1-98f7-65ff6f287b2f"
    assert item.url == "https://jobs.ashbyhq.com/supabase/184c3ad5-5d5f-44a1-98f7-65ff6f287b2f"

