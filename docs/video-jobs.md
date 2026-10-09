# Animated video jobs

The opt-in extension creates **silent motion graphics**, such as product explainers, animated titles, diagrams and bars. A subscription-backed Claude call writes a constrained JSON storyboard; the local renderer rasterizes it with resvg and encodes an H.264 MP4 with FFmpeg. It does not generate realistic footage, voices, images or Claude Motion artifacts. This is a separate renderer built into this proxy, not an integration with Claude Motion's UI.

## Enable

Requires managed mode, Node 22.13+, `npm ci`, FFmpeg with the `libx264` encoder, and DejaVu Sans. The Docker image includes the renderer, encoder and font. Existing deployments keep videos disabled until configured. Configuration example:

```json
{
  "management": {
    "enabled": true,
    "databasePath": "/data/proxy.sqlite"
  },
  "video": {
    "enabled": true,
    "model": "claude-opus-5-5",
    "directory": "/data/videos",
    "maxConcurrent": 2,
    "timeoutMs": 300000,
    "retentionHours": 168,
    "maxJobs": 1000,
    "maxStorageBytes": 1073741824,
    "maxOutputBytes": 52428800,
    "ffmpegPath": "ffmpeg",
    "fontFile": "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
  }
}
```

Merge these fields into the existing configuration: preserve listener bindings, management port, account directories and other settings. The writable persistent volume must contain both the database and video directory. Enable on one proxy process per database/spool; the existing managed store and this job worker do not support multiple replicas sharing the same database. On startup, missing encoder/font support fails before listening, preventing a model invocation followed by an avoidable renderer failure. Test the new container before switching traffic; schema addition is automatic (`video_jobs` table only), and existing account/message behavior is unchanged. Drain the current process first. Rollback keeps the table and files; don't manually rerun an interrupted job with a new key without checking its state.

The model is selected by the operator, not the caller; defaults to Opus 5.5. Opus, Sonnet and Haiku 5.5 are accepted. Claude calls use the existing OAuth subscription transport, account affinity, model-specific cloud quota checks and refresh logic. No Anthropic API-key billing fallback or alternate provider is added. Caller `hbp_` keys authenticate access to **this proxy**, not an API billing account. Renderer CPU/storage are local infrastructure costs; model requests consume the selected account's quota.

## Create and poll

All endpoints are on the existing authenticated inference listener. Supply `x-api-key` or `Authorization: Bearer` with a valid proxy key whose providers include `anthropic`. Existing source-IP rules apply. Jobs belong to the key's persistent ID: another key cannot see the status, storyboard or files. Rotation preserves ownership; deletion, revocation or removing the Anthropic permission denies access and cancels active background work within approximately one second (or at the next stage boundary).

`POST /v1/video-jobs`, with a required `Idempotency-Key` header (1–200 printable ASCII characters without spaces):

```json
{
  "prompt": "Crea un video di presentazione di Hercle Accelerate con titoli e diagrammi. Non inventare dati o promesse.",
  "format": "landscape",
  "duration_seconds": 20
}
```

Only these fields are accepted. Prompt: 1–12,000 characters. Defaults: landscape, 20 seconds. Duration: integer 1–60. Canvas: landscape 1280×720, portrait 720×1280, square 720×720, all 24 fps. Response: HTTP 202 and a `Location` header pointing to the job; processing continues after the HTTP client disconnects.

```json
{
  "id": "5a9e5c92-91b2-46b5-bbe5-1b41d0e9d1fd",
  "status": "accepted",
  "model": "claude-opus-5-5",
  "format": "landscape",
  "duration_seconds": 20,
  "created_at": "2026-10-09T12:00:00.000Z",
  "updated_at": "2026-10-09T12:00:00.000Z"
}
```

Poll `GET /v1/video-jobs/{id}`. States: `accepted` → `generating` → `rendering` → `completed`; terminal alternatives: `failed`, `interrupted`, `cancelled`. A completed job adds `content_url`, `poster_url` and `media` (bytes, SHA-256, width, height, fps, duration). A validated storyboard adds `storyboard_url`. URLs are relative and require the same authentication; they are not public share links. Failures expose a safe `error.code` without raw provider messages or credentials.

- `GET /v1/video-jobs/{id}/content`: MP4, available only when completed.
- `GET /v1/video-jobs/{id}/poster`: PNG, available only when completed.
- `GET /v1/video-jobs/{id}/storyboard`: validated JSON once generation finishes.
- `DELETE /v1/video-jobs/{id}`: request cancellation; HTTP 202, poll until terminal. Completed files cannot be cancelled (409).

Content/poster support `HEAD` and single byte ranges for video playback; malformed or unsatisfiable ranges return 416. Files use `private, no-store`. A browser preview should go through the caller application's authenticated backend; don't put proxy keys in a video URL, browser query string or public post.

## Retries, limits and recovery

The idempotency key is scoped to the caller key ID. The same normalized request and key return the same job, including after completion/failure/restart. Different content with the same key returns 409. Concurrent duplicate submissions create one job/model call. The idempotency digest and canonical input are persisted before acknowledgement. If the caller loses the response, repeat the same key, then poll. Never use a new key merely because a response was lost.

No queue: video worker capacity is bounded (default two active jobs, maximum eight). A job also reserves the existing account/caller/global admission slot during the Claude stage and releases it before rendering. Capacity returns 429; unavailable account quota or draining returns 503 without persisting a new job. Retrying these rejected submissions with the same key is safe.

A restart marks all nonterminal jobs `interrupted`, removes their partial files and never invokes Claude again automatically. Graceful shutdown cancels active model requests and encoders, waits for cleanup, then closes the database. Timeouts abort both stages. Cancellation cannot undo account usage already consumed. Failed/interrupted jobs need a deliberate new request/key if the caller wants to regenerate; a successful model response with an invalid storyboard is a terminal failure, not an automatic repair/retry.

Storyboards contain at most 12 scenes and 24 elements per scene. Only text, rectangles, ellipses and bars with normalized coordinates, hex colors and bounded delays are supported. Built-in animations: fade, slide up and shape growth. Text/attributes are escaped into renderer-owned SVG. No model-generated executable code, raw SVG, HTML, shell commands, URLs, filesystem paths or FFmpeg expressions are accepted. Encoder processes receive a minimal environment without account credentials or caller keys.

Disk reservations account for in-flight jobs. A total storage bound and job-count cap reject further submissions with 503. A per-output cap bounds final media. Terminal records/assets expire after the configured retention interval (default seven days), become inaccessible (410 while the record remains), and are pruned on startup or new submissions. **Idempotency guarantees end when a record is pruned**; callers should use globally unique keys and must not replay old requests beyond retention. Keep prompts, storyboards and files in private storage/backups: filesystem directory permissions are 0700 and database/media files 0600.

## Accelerate integration

Use an HTTP action with a stable per-effect idempotency key to create the job, then poll by returned job ID. Download the finished media via the backend and present it alongside the draft caption in a human approval task. Only the approval branch may reach the social publishing adapter. This extension does not publish to X/LinkedIn, change account permissions, or install an Accelerate workflow; those are separate integrations. The existing generic Accelerate HTTP action does not expose full response JSON, so job-result handling must be added there rather than assuming it already returns the media.

## Verification

`npm ci && npm test` runs the transport, management and job lifecycle tests. For the real encoder integration tests, also set:

```sh
VIDEO_TEST_FFMPEG=/usr/bin/ffmpeg \
VIDEO_TEST_FONT=/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf npm test
```

The CI publish workflow installs these dependencies and exercises actual MP4 decoding, cancellation and the read-only container contract with videos enabled. Tests use synthetic account credentials and controlled model responses: they never call a live provider. A live account check remains necessary after deployment to verify current subscription availability and the quality/compliance of model-generated storyboards.
