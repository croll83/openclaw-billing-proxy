# Antigravity subscription backend

Set `"geminiBackend": "antigravity"` to use an existing Antigravity CLI OAuth
profile for the proxy's Gemini-native routes. The default remains `"cloudcode"`;
Anthropic routing and credentials are unchanged.

Inference calls the upstream API directly. AGY does not execute tools or manage
the caller's conversation. The proxy forwards `contents`, `systemInstruction`,
`tools`, generation settings and signed model parts without rewriting them.
The caller executes `functionCall` and returns `functionResponse`.

This uses an internal protocol, tested with AGY 1.4.3. It is not a supported
Google API integration; Google's restrictions on third-party OAuth reuse still
apply. Fingerprint or protocol changes can require an update.

## Configuration

Example for a separate local test instance:

```json
{
  "port": 18812,
  "bindAddress": "127.0.0.1",
  "geminiBackend": "antigravity",
  "geminiCredentialsPath": "/data/account-home/.gemini/antigravity-cli/antigravity-oauth-token",
  "antigravityCommand": "/usr/local/bin/agy"
}
```

Only `geminiBackend` is required to opt in. The default credential path is
`HOME/.gemini/antigravity-cli/antigravity-oauth-token`; the default command is
`agy` in PATH. Managed mode offers **Connect Antigravity** in the console: each login creates its own HOME, prompts for a Google authorization code, and joins the Gemini pool only after cloud quota verification. **Reconnect** replaces one account profile while retaining its identity and limits. Manual registrations can still use an interactive AGY login under the account's HOME.
An Anthropic credential file is not required for an Antigravity-only instance.
`antigravityUserAgent` can override the observed 1.4.3 fingerprint when a future
CLI version requires it.

The proxy discovers the project through `loadCodeAssist`, not a manually entered
project or the CLI's `cache/default_project_id.txt`. Discovery is cached for five
minutes per credential file/token/fingerprint, with concurrent requests coalesced.

The existing native client can keep using:

- `POST /v1beta/models/gemini-3.8-flash-medium:streamGenerateContent`
- `POST /v1beta/models/gemini-4-argon-medium:generateContent`

The `v1` prefix is also supported in managed mode. Streaming unwraps upstream
SSE incrementally with backpressure and preserves `thoughtSignature`. Non-streaming
uses upstream `generateContent` and returns its complete response.
Managed native routes also accept the unversioned `/models/...` path and the
Gemini client's `x-goog-api-key` header (containing a proxy-issued key).
The credential is never forwarded to Google. Existing `x-api-key` and Bearer
authentication continue to work.

The OpenAI/Anthropic-to-Gemini conversion routes return an explicit 400 in this
mode: the old converters do not preserve signed tool history. Use the existing
Gemini-native Hermes client. This does not replace Gemini Live/WebSocket APIs.
No Hermes gateway configuration or client was changed by this implementation.

## Credential renewal

The AGY credential format is nested (`token.access_token`, `token.expiry`), unlike
legacy Gemini CLI credentials. Credentials are reread for each request.
Near expiry, a single coalesced `agy models` subprocess renews the profile through
the official CLI. It receives the registered profile's HOME, no inherited model
API key overrides, and no prompt. Output is discarded.

The profile must retain the standard `HOME/.gemini/antigravity-cli/antigravity-oauth-token`
layout so the proxy can derive the correct HOME for renewal. Each account needs
its own HOME and interactive login. The process may write CLI auth/cache/log files
inside that HOME. It must be writable.

Renewal times out after 30 seconds, terminates only its own child, and kills that
child after another two seconds if necessary. Discovery/usage requests have a
15-second timeout and bounded response size. Generation uses the existing
60-minute inactivity timeout (`anthropicTimeoutMs`), not a total-duration cap.
Disconnected callers cancel inference; generation is never automatically replayed.

Since 2.4.1, the amd64 Docker image includes both login CLIs in PATH. AGY is
downloaded from the official release with SHA-256 verification. CLI self-updates
are disabled (`AGY_CLI_DISABLE_AUTO_UPDATE=true` is also set on renewal children);
the daily publishing workflow builds fresh tested images instead. Account HOME
and credential/cache paths must be under the writable `/data` volume. OAuth
profiles remain external to the image. See `docs/container-updates.md`.

## Managed accounts and usage

Register the account as provider `gemini` using its full AGY credential-file path.
Leave the project blank. Gemini accounts in this proxy instance must use the
selected backend; mixing legacy Gemini and AGY profiles in one pool is not
supported. API key scopes and sticky affinity remain `gemini`; Anthropic stays
in its separate pool.

The console displays cloud values from:

- `fetchAvailableModels`: per-model remaining quota, used for routing/admission.
- `retrieveUserQuotaSummary`: named account groups/windows and reset times.

No request-based usage estimate or invented weekly/five-hour percentage is used.
Group membership is not guessed from display names. Existing Gemini admission
semantics for unavailable/stale quota remain unchanged.
Guided browser login in the console still covers Anthropic only; AGY profiles are
registered after an external interactive login.

## Verification

Run `npm test` for offline regression and transport tests.

The opt-in live test consumes a small amount of subscription quota:

```sh
node scripts/antigravity-smoke.js
node scripts/antigravity-smoke.js . --test-renewal
```

Run it as the authenticated OS user. `AGY_COMMAND` optionally selects the binary;
the smoke script otherwise uses `HOME/.local/bin/agy`.
Set `HERMES_PYTHON` to an installed Hermes Python interpreter and
`HERMES_DIRECTORY` to its runtime root to additionally exercise that installation's
actual `GeminiNativeClient`, including tool-signature replay and a streaming answer.
It starts temporary managed listeners on kernel-assigned loopback ports with a
private database and ephemeral caller key. It checks health, missing-key rejection,
cloud quotas, and two-turn external-tool conversations on Flash and Argon, with
streaming and non-streaming follow-ups.

`--test-renewal` copies the credential file into a private temporary HOME and
expires only the copy. It verifies a real CLI renewal without modifying the
original file. Temporary profiles, DB, keys and listeners are cleaned up.
Diagnostics contain only test outcomes, never token values or provider bodies.

Live verification passed on 2026-10-20 with AGY 1.4.3 and Node 22.22.0.
All 64 offline tests passed. The installed Hermes GeminiNativeClient also passed
a real tool round-trip with signed history and a streaming follow-up through
the isolated managed proxy, without any changes to that client.
No production service was restarted or replaced. Long-running real Hermes
conversations, multimodal inputs and complex parallel tool calls remain outside
this initial live smoke coverage.
