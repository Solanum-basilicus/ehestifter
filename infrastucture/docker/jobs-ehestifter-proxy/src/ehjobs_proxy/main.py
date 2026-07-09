from __future__ import annotations

import argparse
import hmac
import logging
from contextlib import asynccontextmanager
from typing import Any
from uuid import UUID

import uvicorn
from fastapi import APIRouter, Depends, FastAPI, Header, HTTPException, Query, Request

from .identity import CanonicalIdentity, parse_identity_from_url
from .models import (
    CanonicalIdentityModel,
    ExistsRequest,
    ExistsResponse,
    IdentityRequest,
    IdentityResponse,
    JobCreateRequest,
    JobCreateResponse,
    JobDetailResponse,
    JobSearchResponse,
    MarkAppliedRequest,
    MarkAppliedResponse,
)
from .sanitation import truncate_text, validate_public_http_url
from .settings import Settings, load_settings
from .upstream_jobs import UpstreamJobsClient

logger = logging.getLogger("ehjobs_proxy")


def create_app(settings: Settings, *, jobs_client: Any | None = None) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI):
        created_client = jobs_client is None
        try:
            yield
        finally:
            if created_client and hasattr(app.state.jobs_client, "aclose"):
                await app.state.jobs_client.aclose()

    app = FastAPI(
        title="Ehestifter Jobs Local Proxy",
        version="0.1.0",
        docs_url=None,
        redoc_url=None,
        openapi_url=None,
        lifespan=lifespan,
    )
    # Set state eagerly as well as in lifespan so ASGI test transports that do not
    # trigger lifespan events still exercise the same request code.
    app.state.settings = settings
    app.state.jobs_client = jobs_client or UpstreamJobsClient(settings)

    @app.get("/healthz")
    async def healthz() -> dict[str, Any]:
        return {"ok": True, "service": "ehjobs-proxy"}

    router = APIRouter(prefix="/v1", dependencies=[Depends(require_agent_auth)])

    @router.post("/jobs/identity", response_model=IdentityResponse)
    async def identity(req: IdentityRequest, request: Request) -> IdentityResponse:
        settings = _settings(request)
        if not settings.features.allowUrlIdentityGuess:
            raise HTTPException(status_code=403, detail={"code": "url_identity_guess_disabled"})
        url = validate_public_http_url(req.url)
        assert url is not None
        parsed = parse_identity_from_url(url)
        return _identity_response(parsed.identity, parsed.confidence, parsed.warnings)

    @router.post("/jobs/exists", response_model=ExistsResponse)
    async def exists(req: ExistsRequest, request: Request) -> ExistsResponse:
        identity, warnings = _resolve_identity_from_exists_request(req, request)
        exists_flag, job_id, _ = await _jobs_client(request).exists(identity)
        logger.info(
            "exists outcome=%s provider=%s tenant=%s externalId=%s jobId=%s",
            exists_flag,
            identity.provider,
            identity.providerTenant,
            identity.externalId,
            job_id,
        )
        return ExistsResponse(
            exists=exists_flag,
            jobId=job_id,
            canonicalIdentity=identity,
            warnings=warnings,
        )

    @router.get("/jobs/search", response_model=JobSearchResponse)
    async def search(
        request: Request,
        q: str = Query(min_length=1),
        limit: int = Query(default=10, ge=1),
    ) -> JobSearchResponse:
        settings = _settings(request)
        query = q.strip()
        if not query:
            raise HTTPException(status_code=400, detail={"code": "empty_search"})
        if len(query) > settings.limits.maxSearchLength:
            raise HTTPException(status_code=400, detail={"code": "search_too_long"})
        safe_limit = min(limit, settings.limits.maxPageSize)
        items = await _jobs_client(request).search(query, limit=safe_limit)
        return JobSearchResponse(items=items)

    @router.get("/jobs/{job_id}", response_model=JobDetailResponse)
    async def get_job(job_id: UUID, request: Request) -> JobDetailResponse:
        settings = _settings(request)
        body = await _jobs_client(request).get_job(job_id)
        truncated = _truncate_description_fields(body, settings.limits.maxDescriptionCharsReturned)
        return JobDetailResponse(job=body, descriptionTruncated=truncated)

    @router.post("/jobs", response_model=JobCreateResponse)
    async def create_job(req: JobCreateRequest, request: Request) -> JobCreateResponse:
        settings = _settings(request)
        if not settings.features.allowCreate:
            raise HTTPException(status_code=403, detail={"code": "create_disabled"})

        url = validate_public_http_url(req.url, field_name="url")
        apply_url = validate_public_http_url(req.applyUrl, field_name="applyUrl") if req.applyUrl else None
        description, description_truncated = truncate_text(req.description, settings.limits.maxDescriptionCharsOnCreate)
        normalized_req = req.model_copy(update={"url": url, "applyUrl": apply_url, "description": description})
        identity = normalized_req.canonical_identity()
        warnings: list[str] = []
        if description_truncated:
            warnings.append("description_truncated_before_upstream_create")

        exists_flag, job_id, _ = await _jobs_client(request).exists(identity)
        if exists_flag:
            logger.info(
                "create_preflight outcome=existing provider=%s tenant=%s externalId=%s jobId=%s",
                identity.provider,
                identity.providerTenant,
                identity.externalId,
                job_id,
            )
            return JobCreateResponse(
                outcome="existing",
                jobId=job_id,
                canonicalIdentity=identity,
                warnings=warnings,
            )

        outcome, created_job_id, _ = await _jobs_client(request).create_job(normalized_req)
        logger.info(
            "create outcome=%s provider=%s tenant=%s externalId=%s jobId=%s",
            outcome,
            identity.provider,
            identity.providerTenant,
            identity.externalId,
            created_job_id,
        )
        return JobCreateResponse(
            outcome="existing" if outcome == "existing" else "created",
            jobId=created_job_id,
            canonicalIdentity=identity,
            warnings=warnings,
        )

    @router.post("/jobs/{job_id}/mark-applied", response_model=MarkAppliedResponse)
    async def mark_applied(job_id: UUID, req: MarkAppliedRequest, request: Request) -> MarkAppliedResponse:
        settings = _settings(request)
        if not settings.features.allowMarkApplied:
            raise HTTPException(status_code=403, detail={"code": "mark_applied_disabled"})
        # The request model already enforces exact confirm == "mark-applied".
        await _jobs_client(request).mark_applied(job_id)
        logger.info("mark_applied outcome=status_updated jobId=%s", job_id)
        return MarkAppliedResponse(outcome="status_updated", jobId=job_id)

    app.include_router(router)
    return app


async def require_agent_auth(
    request: Request,
    authorization: str | None = Header(default=None, alias="Authorization"),
) -> None:
    settings = _settings(request)
    expected = f"Bearer {settings.agentAuth.bearerToken.get_secret_value()}"
    if authorization is None:
        raise HTTPException(status_code=401, detail={"code": "missing_authorization"})
    if not hmac.compare_digest(authorization, expected):
        raise HTTPException(status_code=401, detail={"code": "bad_authorization"})


def _settings(request: Request) -> Settings:
    return request.app.state.settings


def _jobs_client(request: Request) -> Any:
    return request.app.state.jobs_client


def _identity_response(
    identity: CanonicalIdentity | None,
    confidence: str,
    warnings: list[str],
) -> IdentityResponse:
    return IdentityResponse(
        ok=identity is not None,
        identity=(
            CanonicalIdentityModel(
                provider=identity.provider,
                providerTenant=identity.providerTenant,
                externalId=identity.externalId,
            )
            if identity
            else None
        ),
        confidence=confidence,  # type: ignore[arg-type]
        warnings=warnings,
    )


def _resolve_identity_from_exists_request(req: ExistsRequest, request: Request) -> tuple[CanonicalIdentityModel, list[str]]:
    warnings: list[str] = []
    settings = _settings(request)

    if req.provider and req.externalId:
        return (
            CanonicalIdentityModel(
                provider=req.provider,
                providerTenant=req.providerTenant or "",
                externalId=req.externalId,
            ),
            warnings,
        )

    if req.url and settings.features.allowUrlIdentityGuess:
        url = validate_public_http_url(req.url)
        assert url is not None
        parsed = parse_identity_from_url(url)
        warnings.extend(parsed.warnings)
        if parsed.identity is not None:
            return (
                CanonicalIdentityModel(
                    provider=parsed.identity.provider,
                    providerTenant=parsed.identity.providerTenant,
                    externalId=parsed.identity.externalId,
                ),
                warnings,
            )

    raise HTTPException(status_code=400, detail={"code": "bad_identity"})


def _truncate_description_fields(body: dict[str, Any], max_chars: int) -> bool:
    truncated = False
    keys = ["description", "jobDescription", "JobDescription"]
    for key in keys:
        value = body.get(key)
        if isinstance(value, str):
            body[key], was_truncated = truncate_text(value, max_chars)
            truncated = truncated or was_truncated
    for nested_key in ["job", "jobOffering", "data"]:
        nested = body.get(nested_key)
        if isinstance(nested, dict):
            truncated = _truncate_description_fields(nested, max_chars) or truncated
    return truncated


def cli_main() -> None:
    parser = argparse.ArgumentParser(description="Run local Ehestifter Jobs proxy")
    parser.add_argument("--config", required=True, help="Path to proxy JSON config")
    parser.add_argument("--log-level", default="info", choices=["debug", "info", "warning", "error"])
    args = parser.parse_args()

    logging.basicConfig(
        level=getattr(logging, args.log_level.upper()),
        format="%(asctime)s %(levelname)s %(name)s %(message)s",
    )

    settings = load_settings(args.config, validate_runtime_files=True)
    app = create_app(settings)
    tls = settings.server.tls
    uvicorn.run(
        app,
        host=settings.server.host,
        port=settings.server.port,
        log_level=args.log_level,
        ssl_certfile=tls.certFile if tls.enabled else None,
        ssl_keyfile=tls.keyFile if tls.enabled else None,
    )


if __name__ == "__main__":
    cli_main()
