## GCP Gateway worker-side smoke result

Date: 2026-06-03

Result: compatibility worker successfully used GCP Cloud Run Gateway for worker-facing calls.

Validated path:

- Enrichers Core still dispatched through Azure Gateway.
- Worker consumed Azure Service Bus message as before.
- Worker called GCP Gateway for `/work/lease`.
- GCP Gateway called Azure Enrichers Core successfully.
- Worker completed enrichment through GCP Gateway.
- Existing enrichment lifecycle remained owned by Enrichers Core.

Important Cloud Run env details:

- `EHESTIFTER_ENRICHERS_BASE_URL` must include `/api`.
- `GATEWAY_SB_CONNECTION_STRING` must match the existing Gateway code expectation.
- `GATEWAY_FUNCTION_KEY` is app-level auth used by the Flask/Cloud Run wrapper.