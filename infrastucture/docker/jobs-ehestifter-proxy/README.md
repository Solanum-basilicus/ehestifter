# Local Ehestifter Jobs Proxy

Local, limited HTTPS proxy for interactive Career-Ops / OpenCode job discovery.

The proxy gives local agents a small, stable job-tracking API without exposing the Azure Jobs Function key to the agent container.

## Boundary

Agent containers receive only:

- proxy base URL
- local proxy bearer token

The proxy receives:

- Azure Jobs base URL
- Azure Jobs `x-functions-key`
- optional `X-User-Id` for user-scoped Jobs calls

The proxy does **not** expose arbitrary upstream forwarding.

## Routes

```text
GET  /healthz
POST /v1/jobs/identity
POST /v1/jobs/exists
GET  /v1/jobs/search?q=...
GET  /v1/jobs/{jobId}
POST /v1/jobs
POST /v1/jobs/{jobId}/mark-applied
```

All `/v1/*` routes require:

```text
Authorization: Bearer <local proxy token>
```

`/healthz` is intentionally unauthenticated for simple local smoke tests.

## Generate local TLS certificate

The generated certificate includes SANs for:

- `ehjobs-proxy`
- `localhost`
- `127.0.0.1`

```bash
./scripts/generate-dev-cert.sh ./secrets
```

## Configure

```bash
mkdir -p ./secrets
cp config.example.json ./secrets/config.json
$EDITOR ./secrets/config.json
```

Important fields:

```json
{
  "agentAuth": {
    "bearerToken": "long-random-local-secret"
  },
  "ehestifter": {
    "jobsBaseUrl": "https://ehestifter-jobs.azurewebsites.net/api",
    "jobsFunctionKey": "Azure Jobs function key created for this proxy",
    "userId": "your internal Ehestifter user GUID",
    "actorMode": "user"
  },
  "features": {
    "allowCreate": true,
    "allowMarkApplied": false,
    "allowUrlIdentityGuess": true
  }
}
```

Leave `allowMarkApplied` as `false` until create/existence behavior is hand-tested.

## Run with Docker Compose

```bash
docker compose -f docker-compose.example.yml up --build
```

The example publishes the proxy only to host loopback:

```text
https://127.0.0.1:8787
```

## Manual tests

Set token:

```bash
export EHJOBS_PROXY_TOKEN='long-random-local-secret'
```

Health check with self-signed TLS ignored:

```bash
curl -k https://localhost:8787/healthz
```

Health check with certificate verification:

```bash
curl --cacert ./secrets/ehjobs-proxy.crt https://localhost:8787/healthz
```

Auth rejection:

```bash
curl -k -i https://localhost:8787/v1/jobs/search?q=test
```

Identity derivation:

```bash
curl -k \
  -H "Authorization: Bearer $EHJOBS_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  https://localhost:8787/v1/jobs/identity \
  -d '{"url":"https://boards.greenhouse.io/example/jobs/123456"}'
```

Existence check by identity:

```bash
curl -k \
  -H "Authorization: Bearer $EHJOBS_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  https://localhost:8787/v1/jobs/exists \
  -d '{
    "provider":"greenhouse",
    "providerTenant":"example",
    "externalId":"123456"
  }'
```

Search:

```bash
curl -k \
  -H "Authorization: Bearer $EHJOBS_PROXY_TOKEN" \
  'https://localhost:8787/v1/jobs/search?q=Example%20product%20manager&limit=10'
```

Create candidate:

```bash
cat > /tmp/candidate.json <<'JSON'
{
  "url": "https://boards.greenhouse.io/example/jobs/123456",
  "applyUrl": "https://boards.greenhouse.io/example/jobs/123456",
  "foundOn": "career-ops",
  "provider": "greenhouse",
  "providerTenant": "example",
  "externalId": "123456",
  "title": "Senior Product Manager",
  "hiringCompanyName": "Example GmbH",
  "postingCompanyName": null,
  "remoteType": "Hybrid",
  "description": "Full job description if available",
  "locations": [
    {
      "countryName": "Germany",
      "countryCode": "DE",
      "cityName": "Berlin",
      "region": null
    }
  ]
}
JSON

curl -k \
  -H "Authorization: Bearer $EHJOBS_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  https://localhost:8787/v1/jobs \
  --data-binary @/tmp/candidate.json
```

Create response shape:

```json
{
  "outcome": "created",
  "jobId": "11111111-1111-1111-1111-111111111111",
  "canonicalIdentity": {
    "provider": "greenhouse",
    "providerTenant": "example",
    "externalId": "123456"
  },
  "warnings": []
}
```

There is intentionally no `statusChanged` field.

Mark applied is disabled by default:

```bash
curl -k \
  -H "Authorization: Bearer $EHJOBS_PROXY_TOKEN" \
  -H "Content-Type: application/json" \
  https://localhost:8787/v1/jobs/11111111-1111-1111-1111-111111111111/mark-applied \
  -d '{"confirm":"mark-applied"}'
```

Expected while disabled:

```json
{"detail":{"code":"mark_applied_disabled"}}
```

## Local development

```bash
python -m venv .venv
. .venv/bin/activate
pip install -e '.[test]'
pytest
```

Run without TLS for local unit-style experiments only:

```json
{
  "server": {
    "tls": {"enabled": false}
  }
}
```

Then:

```bash
ehjobs-proxy --config ./secrets/config.json
```

## Known adaptation points

The upstream Jobs API response shapes are parsed defensively, but the following may need adjustment after first real hand tests:

- exact `/jobs/exists` JSON body shape
- exact `POST /jobs` success body field for job ID
- exact list/search query parameter names accepted by `GET /jobs`
- exact status update body expected by `PUT /jobs/{jobId}/status`

Do not change the local proxy contract casually after OpenCode skill work starts.
