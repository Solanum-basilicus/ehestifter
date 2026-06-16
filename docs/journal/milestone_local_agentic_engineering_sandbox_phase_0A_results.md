## Phase 0A result

Status: accepted.

Environment:
- tiny repo: `$INFRA/agentic-engineering-sandbox/phase-0a/tiny-repo`
- opencode image: `ehestifter/opencode-local:phase-0a`
- local model API: `http://$INFERENCEHOST:8081/v1`
- model: `Qwen_Qwen3.5-9B-Q8_0.gguf`
- Docker network mode: `bridge`

Result:
- opencode successfully edited `README.md` in the disposable tiny repo.
- The local intranet OpenAI-compatible inference endpoint was reachable from Docker bridge networking.
- No host-network fallback was required.
- No external provider credentials were required.
- Container environment checks found no GitHub token, Azure credentials, or GCP credentials.
- `/var/run/docker.sock` was not mounted.
- Workspace inspection showed only the disposable tiny repo under `/workspace`.
- `opencode.json` was mounted from outside the tiny repo at `/tmp/opencode-home/.config/opencode/opencode.json`.
- `/proc/mounts` showed the mounted config file as readonly.

Diff:

```diff
diff --git a/README.md b/README.md
index 8b15be2..279f4f4 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,5 @@
 # Tiny Repo
 
 Initial text.
+
+This repo is used for Phase 0A opencode local model smoke test.