# Images through a ChatGPT account

The opt-in worker runs **Codex native image generation authenticated with ChatGPT**, consuming that account's Codex quota. It does not use the Images API, OpenAI API keys, API billing fallback or Claude for image generation. This is a single dedicated account worker for trusted internal automation, not an external customer credential service.

## Architecture and version boundary

`POST /v1/image-jobs` → durable job/admission → Codex CLI → native `image_gen` → validated PNG → authenticated download.

The CLI is pinned to **0.162.0-alpha.2**, the npm-distributed version used in the live generation test. The container includes it. Startup verifies this version, the native `image_generation` feature and ChatGPT sign-in. Other versions fail closed until tested and explicitly updated.

The adapter consumes JSONL `thread.started` / `turn.completed` events and collects this version's native output at `CODEX_HOME/generated_images/{thread_id}`. That directory contract was verified with a real generation, but it is version-specific. It is not a guarantee about future releases. The worker never trusts assistant prose, claimed success or a returned arbitrary filesystem path.

The process receives an allowlisted environment without API keys, provider URLs or proxy keys. It forces `model_provider=openai`, `forced_login_method=chatgpt`, ephemeral execution and a read-only sandbox; ignores user configuration; disables shell tools, apps/plugins, hooks, browser/computer use, image viewing, web search and subagents. Unexpected command/file/MCP/web/agent events fail the job. The prompt is passed over stdin. No execution rules are bypassed, and proxy code never reads/copies account tokens.

Collection requires exactly one regular PNG from that structured thread's directory. Symlinks, stale output, bad PNG/CRC, oversized files/pixels and missing requested transparency are rejected. After copying into the private spool, only that newly generated thread output is removed; unrelated/stale files are preserved. Cancellation aborts account checks and kills the active process group. Failures/timeouts/restarts never automatically regenerate an image.

## Configure a dedicated account

Use a private (0700), persistent directory writable by the service user. Do not use a developer's personal Codex home. For the existing Docker deployment:

```sh
docker exec --user 10001:10001 proxy mkdir -p -m 700 /data/codex-images
docker exec --user 10001:10001 -it proxy \
  env CODEX_HOME=/data/codex-images codex login --device-auth
```

Replace `proxy` with the actual container name. The account owner completes the one-time browser sign-in; device-code login must be enabled on their ChatGPT account/workspace. The proxy does not expose remote login or accept account credentials via its API. Never paste tokens into chat or commit/copy auth caches into this repository.

Verify sign-in without generating an image:

```sh
docker exec --user 10001:10001 proxy \
  env CODEX_HOME=/data/codex-images codex login status
```

Expected: `Logged in using ChatGPT`. API-key mode is rejected. Then merge this into the existing managed configuration, preserving its listener/account settings:

```json
{
  "images": {
    "enabled": true,
    "codexHome": "/data/codex-images",
    "codexPath": "codex",
    "directory": "/data/images",
    "maxConcurrent": 1,
    "timeoutMs": 300000,
    "retentionHours": 168,
    "maxJobs": 1000,
    "maxStorageBytes": 1073741824,
    "maxOutputBytes": 20971520
  }
}
```

Managed mode is required. Database, spool and Codex home must be on persistent private storage. The service requires the Codex home to be owned by its user with no group/world permissions, both at startup and before each job. Authenticate **before enabling**: an unavailable worker/version/account fails startup before opening listeners. Keep one proxy process per database/spool. Media storage bounds cover the job spool, not the CLI's own cache/state or the SQLite database. Optional `images.agentModel` pins an available Codex reasoning model, such as `gpt-6.1-sol`; otherwise Codex selects its default. The native image generator is `gpt-image-2`.

This account is separate from the Anthropic/Gemini pool: no Codex account rotation or proactive cloud-quota polling is added. Native Codex enforces actual account usage limits; no remaining quota is invented. The worker shares global/caller concurrency admission and adds its own account slot (one by default). Reports use provider `codex`, account `codex-image-worker`, image model `gpt-image-2`.

Verify one image in the target Linux staging container. Codex must be able to apply the read-only sandbox under the host's kernel/container policy; inability to do so fails generation rather than disabling the sandbox. The local macOS test does not establish that deployment compatibility.

## Client permission and API

Grant `codex` explicitly on a proxy client key. A client needing Claude text/video plus images can use `providers:["anthropic","codex"]`. Existing/default keys remain `anthropic, gemini`; they do not gain image access. The console key editor supports `codex`. The image account uses `images.codexHome`, not the Anthropic/Gemini account editor.

On the authenticated inference listener, send `x-api-key` or `Authorization: Bearer`. `POST /v1/image-jobs` requires `Idempotency-Key` (1–200 printable ASCII characters, no spaces):

```json
{
  "prompt": "Una fotografia da studio di un piccolo cesto arancione su fondo blu scuro, senza testo o loghi.",
  "aspect_ratio": "square",
  "transparent_background": false
}
```

Only these fields are accepted. Prompt: 1–12,000 characters. Ratio: square (default), landscape or portrait; this guides composition, **not an exact pixel size**. Transparency defaults false and must actually appear in the decoded PNG when requested. Native output is preserved without resizing/cropping. Limits: configured byte cap, 4096 per edge, 8,388,608 total pixels.

Creation returns 202, `Location: /v1/image-jobs/{id}`, job ID, status, image model, requested ratio/transparency and timestamps. Poll `GET /v1/image-jobs/{id}`. Completion adds `content_url` and `media`: actual bytes, width, height, content type, SHA-256 and transparency. States: accepted → generating → completed; terminal alternatives failed, interrupted, cancelled.

- `GET /v1/image-jobs/{id}/content`: PNG, authenticated, private/no-store.
- `HEAD /v1/image-jobs/{id}/content`: authenticated type/length.
- `DELETE /v1/image-jobs/{id}`: request cancellation (202), then poll; completed jobs return 409.

Another key cannot access a job or its file. Rotation preserves the key's identity; revocation/deletion/removal of `codex` denies access and cancels active work. Source-IP rules apply. Never place proxy keys in a browser image URL; preview through the caller's authenticated backend. Errors expose safe codes without raw CLI/provider messages or account information.

## Recovery and release verification

Both media types share `src/media/jobs.js`: canonical fingerprint, per-key idempotency digest, persistence before acknowledgement, bounded capacity/storage, revocation, cancellation, expiry and interrupted-restart recovery. Tables/spools are separate, so either feature can be enabled independently.

Same key/content returns the same job; different content returns 409. Reuse the same key after a lost HTTP response. Failures/interrupted jobs may have consumed account quota and never retry automatically; deliberate regeneration needs a new unique key. The guarantee is one persisted job/CLI invocation per proxy idempotency key; it is not an exactly-once billing guarantee over Codex/provider internal retries. Multiple saved PNGs fail validation rather than being silently accepted. Capacity returns 429; draining/storage admission returns 503 before persisting/invoking the worker. Default retention is seven days; terminal records/files are pruned on startup/new submissions. Idempotency guarantees end after pruning.

Tests run a controlled executable through the **real child-process adapter** and authenticated HTTP listener: auth/version checks, valid/missing/duplicate output, environment, private files, simultaneous retries, shared admission, cancellation, timeout, revocation, restart, retention and symlink/stale-output rejection. No automated test signs into or consumes a live account. The transport/management tests and real MP4 encoding/decoding remain in the same suite.

A separate live local run of this worker, using the pinned npm CLI with the existing ChatGPT sign-in, produced a decoded PNG **1254×1254, 1,894,898 bytes**, SHA-256 `d7f13b6e01513e1db8dd7676e49c8645404f6f7e61085add03c70e5a39d08234`. Only native image generation was used, with shell/plugins/other agents disabled and no API-key environment. This proves the account path on macOS; the target Linux deployment and a different account still need staging checks.

Before rollout: pass CI container checks, complete account login, generate one staging image and one video through the configured Claude account, then grant the intended caller permission. Disabling an extension preserves receipts/files; schema additions are automatic and additive. Social publication remains a separate Accelerate integration with human preview/approval.

Official sources: [native image generation and quota](https://learn.chatgpt.com/docs/image-generation), [scripted CLI execution](https://learn.chatgpt.com/docs/cli/reference), [ChatGPT authentication](https://learn.chatgpt.com/docs/auth).
