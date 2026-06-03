# Milestone: GCP Gateway Hosting Experiment

## 1. Goal

Run the Ehestifter Gateway on Google Cloud Platform side-by-side with the existing Azure deployment.

The goal is to gain practical GCP experience while moving only a narrow, low-risk component across clouds.

Gateway was selected because it has a clean service boundary:

* worker-facing HTTP APIs,
* Service Bus dispatch bridge,
* worker lease and completion forwarding,
* no ownership of Jobs, Users, or Enrichment domain data.

The target result is that GCP Cloud Run Gateway becomes the default production Gateway endpoint, while Azure Gateway remains available as a rollback path.

---

## 2. Current decision

GCP Cloud Run Gateway is considered the preferred/default Gateway environment until further notice.

Operationally this means:

* compatibility worker should use the alternative Gateway config,
* Enrichers Core should also use the alternative Gateway config once dispatch switching is implemented,
* Azure Gateway remains deployed and usable as fallback,
* switching is explicit through environment variables,
* there is no automatic fallback between Azure and GCP Gateway.

This is intentional. Automatic fallback is avoided because dispatch operations can be ambiguous: a timeout may mean the Service Bus message was enqueued but the response was lost. Retrying through a second Gateway could create duplicate dispatch messages and confusing diagnostics.

---

## 3. Scope

### 3.1 In scope

* Refactor Gateway route logic into provider-neutral handlers.
* Keep Azure Functions Gateway wrapper operational.
* Add Flask/Gunicorn wrapper for GCP Cloud Run.
* Containerize Gateway for Cloud Run.
* Deploy Gateway manually to GCP Cloud Run.
* Store GCP Gateway secrets in GCP Secret Manager.
* Add worker-side explicit Gateway switch.
* Validate worker-facing calls through GCP Gateway.
* Add improved Gateway logging for upstream Enrichers Core failures.

### 3.2 Out of scope

* Moving Jobs, Users, Enrichers Core, Azure SQL, or Azure Blob Storage to GCP.
* Replacing Azure Service Bus with GCP Pub/Sub.
* Replacing the current function-key-style service authentication model globally.
* Adding automatic failover between Azure and GCP Gateway.
* GitHub Actions deployment automation for GCP Gateway.
* Custom domain setup for GCP Gateway.
* Moving browser Web Core or Entra ID auth to GCP.

---

## 4. Design

Gateway is now structured so that hosting wrappers are thin and route behavior is shared.

Conceptual split:

```text
Azure Functions wrapper
  -> provider-neutral handlers
  -> existing helpers

Flask / Cloud Run wrapper
  -> provider-neutral handlers
  -> existing helpers
```

Azure Gateway continues to rely on Azure Functions platform-managed function-key authentication.

GCP Gateway emulates the same service-level auth shape by checking `x-functions-key` in the Flask/Cloud Run wrapper before invoking shared handlers.

Gateway remains stateless. Enrichers Core still owns run lifecycle, latest-run checks, leasing, completion validation, and projection dispatch.

---

## 5. Cloud Run deployment

Current GCP deployment:

```text
project: ehestifter-gcp
region: europe-west3
service: ehestifter-gateway
validated image: europe-west3-docker.pkg.dev/ehestifter-gcp/ehestifter/ehestifter-gateway:manual-002
latest validated revision: ehestifter-gateway-00008-h97
```

Current Cloud Run runtime configuration:

```text
EHESTIFTER_ENRICHERS_BASE_URL=https://ehestifter-enrichers.azurewebsites.net/api
GATEWAY_SB_QUEUE_NAME=enrichment-requests
GATEWAY_FUNCTION_KEY=<Secret Manager: gateway-gcp-function-key>
EHESTIFTER_ENRICHERS_FUNCTION_KEY=<Secret Manager: gateway-gcp-enrichers-function-key>
GATEWAY_SB_CONNECTION_STRING=<Secret Manager: gateway-gcp-sb-connection-string>
```

Important findings:

* `EHESTIFTER_ENRICHERS_BASE_URL` must include `/api`.
* Gateway code expects `GATEWAY_SB_CONNECTION_STRING`, not `SB_CONNECTION_STRING`.
* Gateway code expects `GATEWAY_SB_QUEUE_NAME`, not `SB_QUEUE_NAME`.
* `GATEWAY_FUNCTION_KEY` is used by the Flask/Cloud Run wrapper to emulate Azure-style function-key auth.

The Cloud Run service URL should be retrieved with:

```bash
gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format='value(status.url)'
```

This value is used as the Gateway base URL for worker and Enrichers Core alternative Gateway configuration.

---

## 6. Worker Gateway switch

Compatibility worker supports an explicit Gateway switch.

Template shape:

```env
# Gateway - primary, normally Azure Function App
GATEWAY_BASE_URL="https://YOUR-GATEWAY.azurewebsites.net"
GATEWAY_API_KEY="YOUR_AZURE_GATEWAY_KEY"

# Gateway - alternative, currently GCP Cloud Run Gateway.
# This is currently the preferred/default production Gateway path.
# Keep USE_GATEWAY_ALTERNATIVE=1 unless deliberately rolling back to Azure Gateway.
USE_GATEWAY_ALTERNATIVE="1"
GATEWAY_ALTERNATIVE_BASE_URL="https://YOUR-GCP-GATEWAY.run.app"
GATEWAY_ALTERNATIVE_API_KEY="YOUR_GCP_GATEWAY_KEY"
```

Behavior:

```text
USE_GATEWAY_ALTERNATIVE=0 -> worker uses Azure Gateway
USE_GATEWAY_ALTERNATIVE=1 -> worker uses GCP Gateway
```

There is no fallback. The setting selects exactly one Gateway URL/key pair.

---

## 7. Validated worker-side result

Worker-side GCP Gateway integration succeeded.

Validated path:

```text
Enrichers Core
  -> Azure Gateway
  -> Azure Service Bus
  -> compatibility worker
  -> GCP Cloud Run Gateway
  -> Azure Enrichers Core
```

Observed successful behavior:

1. Enrichers Core dispatched work through the existing Azure Gateway.
2. Worker consumed the Azure Service Bus message as before.
3. Worker used GCP Cloud Run Gateway for `/work/lease`.
4. GCP Gateway called Azure Enrichers Core successfully.
5. Worker completed the enrichment through GCP Gateway.
6. Existing enrichment lifecycle remained owned by Enrichers Core.

This confirms that worker-facing Gateway calls can run through GCP without moving Enrichers Core, Service Bus, Jobs, Users, SQL, or storage.

---

## 8. Operational diagnostics added

Gateway upstream logging was improved for Enrichers Core calls.

When Enrichers Core does not cooperate, Gateway now logs:

* method,
* path,
* configured Core base URL,
* upstream status code,
* response body snippet,
* transport-level exception type when applicable.

This was added because an incorrect `EHESTIFTER_ENRICHERS_BASE_URL` silently surfaced to the worker as `404 Not found`, without making the missing `/api` suffix obvious.

Service Bus dispatch logging already included useful start/success/failure diagnostics and was mostly left unchanged.

---

## 9. Known quirks and decisions

### 9.1 `/healthz`

`/healthz` was not treated as a blocking validation endpoint during the manual deployment.

Validated endpoints were:

```text
GET  /ping
POST /work/lease
POST /gateway/dispatch
```

`/ping` and the protected Gateway routes are sufficient for this milestone. `/healthz` can be fixed or removed later.

### 9.2 Cloud Run URL

Use the value returned by:

```bash
gcloud run services describe "$SERVICE_NAME" \
  --project "$PROJECT_ID" \
  --region "$REGION" \
  --format='value(status.url)'
```

A custom domain may be preferable if GCP Gateway remains long-term production infrastructure.

### 9.3 Cost posture

Cloud Run is currently deployed with:

```text
min instances: 0
max instances: 2
concurrency: 8
timeout: 120s
```

This is intentionally conservative for hobby-budget usage.

A low GCP billing budget alert should be configured before treating the service as permanently production-critical.

---

## 10. Next phase: Enrichers Core switch

Add the same explicit Gateway switch to Enrichers Core dispatch logic.

Expected environment shape:

```env
# Gateway - primary, normally Azure Function App
GATEWAY_API_BASE_URL="https://YOUR-AZURE-GATEWAY.azurewebsites.net"
GATEWAY_FUNCTION_KEY="YOUR_AZURE_GATEWAY_KEY"

# Gateway - alternative, currently GCP Cloud Run Gateway.
# This is intended to be the default production path after this milestone.
USE_GATEWAY_ALTERNATIVE="1"
GATEWAY_ALTERNATIVE_API_BASE_URL="https://YOUR-GCP-GATEWAY.run.app"
GATEWAY_ALTERNATIVE_FUNCTION_KEY="YOUR_GCP_GATEWAY_KEY"
```

Expected dispatch behavior:

```text
USE_GATEWAY_ALTERNATIVE=0 -> Enrichers dispatches through Azure Gateway
USE_GATEWAY_ALTERNATIVE=1 -> Enrichers dispatches through GCP Gateway
```

Rules:

* no automatic fallback,
* log selected Gateway base URL at dispatch time,
* never log function keys,
* keep Azure Gateway available as rollback,
* do not change Gateway code for this phase.

---

## 11. Acceptance criteria

This milestone is complete when:

1. Gateway can run on Azure Functions and GCP Cloud Run from the same route behavior.
2. GCP Cloud Run Gateway is manually deployed and reachable.
3. GCP Gateway protects worker routes with `x-functions-key`.
4. Worker can use GCP Gateway for lease and completion.
5. Enrichers Core can dispatch through GCP Gateway.
6. One full enrichment run succeeds with both Enrichers Core and worker configured to use GCP Gateway.
7. Azure Gateway remains available as explicit rollback.
8. There is no automatic dual-dispatch or fallback behavior.

---

## 12. Rollback

To roll worker back to Azure Gateway:

```env
USE_GATEWAY_ALTERNATIVE="0"
```

To roll Enrichers Core back to Azure Gateway after its switch is implemented:

```env
USE_GATEWAY_ALTERNATIVE="0"
```

Rollback should not require code changes, only environment configuration changes and service restart/redeploy where applicable.

---

## 13. Follow-up work

Potential follow-ups:

* add GitHub Actions deployment for GCP Gateway,
* set up GCP budget alert,
* add custom domain for GCP Gateway,
* clean up `/healthz`,
* document GCP manual deployment commands,
* add isolated unit tests for Gateway handlers,
* consider Pub/Sub experiment later as a separate milestone.
