# Ehestifter

Ehestifter is a hobby-scale applicant tracking and job-discovery system built to gain practical experience with Azure, GCP, local inference, and agentic development workflows.

The application keeps shared job offerings, per-user application status, CV data, compatibility projections, and selected product analytics. ATS Discovery periodically searches supported company applicant-tracking systems, filters candidates against eligible user profiles, imports missing shared jobs through the Jobs API, and requests compatibility only for matched users.

## Implemented system

| Area | Responsibility | Runtime |
|---|---|---|
| Web Core | Browser authentication, server-rendered UI, proxy/orchestration routes | Azure App Service |
| Users | User profile, CV blobs/metadata, Telegram identity, discovery-eligible profiles | Azure Functions + Azure SQL/Blob |
| Jobs | Shared job offerings, canonical identity, user status, compatibility projections | Azure Functions + Azure SQL |
| Enrichment Core | Compatibility run lifecycle, snapshots, projection dispatch | Azure Functions + Azure Blob |
| Gateway | Worker-facing Service Bus bridge | GCP Cloud Run by default; Azure Functions rollback |
| Compatibility Worker | Local prompt/inference execution | Docker + local llama.cpp |
| Analytics | Owned event log and best-effort Mixpanel EU export | GCP Cloud Run + Azure SQL |
| ATS Discovery | Provider scanning, catalogs, health, filtering, import, scheduling | Local Docker + system-level systemd timers |
| Telegram Bot | Lightweight application-status and link workflows | Azure App Service |

The master as-is architecture and ownership rules are in [`docs/system-design.md`](docs/system-design.md).

## Repository layout

```text
backend/
  analytics/          analytics ingestion and Mixpanel dispatch
  core/               Flask web UI and browser-facing proxy routes
  enrichers/          enrichment lifecycle and snapshots
  gateway/            Service Bus bridge and hosting wrappers
  jobs/               Jobs bounded context
  telegrambot/        Telegram UX
  users/              Users bounded context
infrastructure/       cloud and local infrastructure assets
scrapers/
  ats-discovery/      local ATS discovery scanner and scheduler
workers/
  compatibility/      local compatibility worker
docs/
  system-design.md    canonical as-is architecture
  archive/milestones/ completed milestone design records
```

## ATS Discovery

The canonical scanner path is:

```text
scrapers/ats-discovery
```

Its product identity is `ats-discovery`; Career-Ops remains an attributed upstream source for selected provider implementations, not the Ehestifter component name.

From the scanner directory, routine operator entry points are:

```bash
./ops/scheduler/ats-ops validate-config
./ops/scheduler/ats-ops status
./ops/scheduler/ats-ops scanner -- scan tracked --offline
```

Use the scheduler wrapper for routine manual scans after timers are installed. Direct `docker compose run` commands bypass the host lock and are intended for controlled validation only.

See [`scrapers/ats-discovery/README.md`](scrapers/ats-discovery/README.md) for architecture, configuration, validation, scheduling, and operational commands.

## Core design rules

- Each bounded context owns its tables and write model.
- Cross-domain writes go through owner-domain APIs.
- Browser code calls Web Core, not domain functions directly.
- Jobs owns canonical job identity and shared persistence.
- ATS Discovery never creates user application status.
- Compatibility and status remain per `(jobId, userId)` while jobs remain shared.
- Analytics is best-effort and must not affect product correctness.
- Gateway selection is explicit; there is no automatic Azure/GCP dual dispatch.
- Provider traffic is bounded, measurable, and governed by provider/variant health.

## Environment posture

This is one budget-constrained hobby environment, not a production/staging fleet. Azure hosts most product domains and storage, GCP hosts the preferred Gateway and Analytics runtime, and a local development node runs compatibility inference and ATS Discovery. Changes should remain incremental, reversible, and conservative about recurring cloud cost.

## Documentation

- [`docs/system-design.md`](docs/system-design.md) — current as-is architecture and guardrails.
- [`docs/archive/milestones/ats-discovery.md`](docs/archive/milestones/ats-discovery.md) — archived implementation design and phase history for ATS Discovery.
- Component-local READMEs — implementation and operator detail.

Historical phase records are evidence of implementation decisions; the master system design and current component README are authoritative for steady-state behavior.
