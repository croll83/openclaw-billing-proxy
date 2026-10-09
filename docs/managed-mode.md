# Managed proxy: accounts, access and reporting

Managed mode is opt-in. It retains the 60-minute **idle** timeout and unchanged Anthropic response streaming. Run one proxy process per database; concurrency limits and refresh coordination are process-local. It requires Node.js 22.13+ for built-in `node:sqlite` (experimental in Node 22/24). No npm runtime dependencies or external database are needed.

## Start a separate instance

Copy `config.managed.example.json` to a private configuration file and run:

```bash
node index.js --config config.managed.private.json
```

The example uses inference port 18802 and console port 18803 on loopback. It does not replace the deployed service on 18801. The console accepts loopback or Tailscale IP bindings only. Open `http://127.0.0.1:18803`, or the configured Tailscale IP and port. There is no console login. Admin access is network access; caller API keys cannot administer the proxy. The console validates its Host and Origin and requires a custom header for mutations to prevent cross-site browser requests. DNS aliases/reverse proxy hostnames are not accepted by default.

Management mode starts with no accounts and no keys. It does not import the workstation's active account automatically. The old `credentialsPath` is not used as a fallback. Without `management.enabled: true`, the legacy server still starts.

## Accounts and isolated provider pools

For Anthropic, choose **Connect Anthropic** in the console. Enter an account name and concurrency limit, open the provider sign-in link, and select the intended subscription. If the browser displays an authorization code (typical when the proxy runs remotely), paste it into the console. After Claude Code exits successfully, the proxy validates renewable credentials and reads subscription usage directly from Anthropic before registering the account. No generation is sent for this check.

One Claude Code installation on the proxy host is sufficient. Each attempt runs `claude auth login --claudeai` with its own `CLAUDE_CONFIG_DIR`. The console manages paths automatically. Configure `management.claudeCommand` when the service cannot find `claude` in its PATH (an absolute executable path, not a shell command). `management.accountsDirectory` defaults to `accounts` beside the database. The included example uses `data/accounts`. This adapter targets the Linux CLI flow; it is not an independent implementation of provider OAuth.

The console never requests the provider password. OAuth codes go only to the isolated CLI's stdin; raw CLI output and tokens are not exposed or logged. Profile directories are private (0700) and accepted credential files are 0600. Child processes do not inherit the proxy host's Anthropic/Claude authentication overrides. Authorization links and codes are transient, not persisted in SQLite.

**Reconnect** retains the existing account ID and reports. Wait for its active requests to finish first (disable it to drain if necessary). While reconnecting, the account is excluded from routing and periodic quota refreshes. A new profile is staged; the account reference changes atomically with its verified cloud quota. Cancellation or failure preserves the previous registration. If cloud verification temporarily fails, **Retry cloud verification** reuses the staged login without launching another CLI. A provider-requested retry delay is respected. Other accounts continue serving normally.

Sessions expire after 10 minutes, with at most four simultaneous logins. Closing the dialog does not cancel login: use **Resume login** in Account pools, including after reloading the page, or explicitly cancel it. A proxy restart loses pending login sessions; start a new attempt. Graceful shutdown terminates only login children created by this proxy and cleans staged profiles. A process crash can leave an unregistered private profile directory; old successfully linked profiles and credentials belonging to deleted accounts are retained for deliberate operator cleanup, never auto-deleted.

Tokens renew automatically based on the provider's expiry, with a five-minute refresh margin for Anthropic. There is no promised interval between interactive logins. A rejected access token from the usage endpoint triggers one refresh/retry; an unrecoverable refresh (`invalid_grant` or missing refresh token), or a repeated HTTP 401, sets **Login required** and excludes the account from routing. Network failures, HTTP 429 and HTTP 403 are not classified as revoked login; quota freshness and cooldown rules still apply. The console exposes **Reconnect** to recover. Successful cloud checks clear the login-required state. Existing databases receive an additive `authStatus` column automatically.

The guided flow currently covers **Anthropic**. Gemini continues to use **Register credential file**, as do advanced/manual Anthropic setups:

Register each subscription account by its own absolute OAuth credentials file path **on the proxy host**. Obtain the file through the provider's normal login flow under a separate CLI configuration/profile. Do not copy one account's file multiple times to simulate multiple subscriptions. Aliases to the same canonical file are rejected, but different copies of the same account cannot be reliably identified from every provider's credential format.

- Anthropic files use `claudeAiOauth.accessToken`, `refreshToken`, and `expiresAt`.
- Gemini files use `access_token`, `refresh_token`, and `expiry_date`. Each Gemini account also requires its own Cloud Code project ID. Configure the Gemini OAuth client ID/secret in the private proxy configuration.
- Token contents are never returned by the console or API. CRUD manages labels, provider, credential-file references, enabled state and concurrency limits. Deleting an account does not delete its credentials file or its historical reports.
- Disable an account to drain it. Existing requests continue; no new requests select it. Editing other fields or deleting an account with active requests returns 409.
- OAuth refresh is single-flight per credentials file and uses atomic private writes. Do not run multiple proxy processes against the same account credentials without an external coordinator.

The provider is selected from the endpoint/model, and stays fixed for the entire request. Anthropic requests only use Anthropic accounts; Gemini requests, including native endpoints, only use Gemini accounts. Gemini quota exhaustion never causes an Anthropic fallback, or vice versa.

## Cloud utilization is authoritative

**Anthropic subscription usage is read exclusively from the provider**, via `GET https://api.anthropic.com/api/oauth/usage`. The adapter preserves cloud `utilization` percentages and `resets_at` timestamps for the 5-hour, 7-day and available Opus/Sonnet weekly windows. It does not infer quota from tokens, request counts or estimated prompt size. A read-only protocol check against a real account returned HTTP 200 with both main windows; automated tests use synthetic credentials and mocked responses.

Each enabled account is polled every two minutes. Manual refresh is single-flight with a minimum 30-second interval per account. Failed reads retain the last successful value plus a visible error and observation timestamp. An Anthropic account without cloud readings, or with readings older than five minutes, is excluded from new requests until cloud reporting recovers. Exhausted applicable windows also exclude it until reset or a new cloud reading. This deliberately favors accurate routing over availability during a prolonged quota endpoint outage.

Gemini uses `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` with the account's project. This is the endpoint used in the [Gemini CLI implementation](https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/code_assist/server.ts). Its model quota buckets and reset times are shown as returned; no Anthropic-style 5-hour/weekly windows are invented. Unknown Gemini quota remains visibly unknown; available recent, exhausted model buckets and real 429s exclude capacity. This adapter has mocked integration coverage, not a live multiaccount validation.

These CLI-facing cloud endpoints are not assumed to be a stable public API. Schema/network errors appear as unavailable data, never zero usage. Requests already accepted are not interrupted when a polling update changes account availability. Polling cannot reserve cloud quota or account for activity occurring after the latest snapshot, so upstream limits remain authoritative.

Successful cloud snapshots are retained for 30 days. The console/API can inspect the most recent 1,000 samples in the last seven days. Separately, **proxy traffic** reports counts, completed HTTP responses, disconnects and average duration over rolling 5-hour/7-day lookbacks. These are operational statistics, not subscription utilization. HTTP completion does not establish answer quality or rule out model refusal. No prompts, outputs or local token-to-quota estimates are stored in this database.

## Caller keys and source filtering

Create a key for each calling application. The secret is cryptographically random, displayed once, and stored only as a SHA-256 digest. Supply it via `x-api-key` or `Authorization: Bearer …`. When both exist, `x-api-key` takes precedence. Rotation invalidates the old secret immediately for new admissions. Revocation or deletion does not interrupt requests already running.

Each key has an application label, key name, allowed APIs (`anthropic`, `gemini`), optional source IP/CIDR allowlist, and concurrent-request limit. Empty IP rules allow any source that can reach the inference listener. IPv4 and IPv6 are supported. The filter uses the socket peer address; `X-Forwarded-For` is never trusted. If another proxy sits in front, its actual peer IP is what this instance sees.

Only inference routes are accepted on the caller listener:

- `POST /v1/messages` and `/v1/messages/count_tokens` for Anthropic.
- `POST /v1/messages` or `/v1/chat/completions` with a Gemini model for format conversion.
- Native Gemini `POST /v1[beta]/models/gemini…:generateContent` or `:streamGenerateContent`.
- `GET /health` exposes only a minimal liveness/draining status without credentials.

Caller credentials and `x-proxy-session` are removed before forwarding upstream. Account OAuth authentication is attached separately by each provider handler.

## Concurrency and routing

Defaults: 32 active requests globally, 4 per caller key, 2 per account; each is configurable. The pool selects only enabled, non-exhausted, non-cooling accounts with free slots in the requested provider.

Affinity is automatic: **API key identity + socket source IP + provider**. No client session field is required. `x-proxy-session` is ignored and stripped; forwarding headers do not influence affinity. IPv4-mapped IPv6 peers are normalized. Systems behind one NAT or reverse proxy using the same key share a preferred account; separate application keys provide separate bindings. The requested model is never changed.

On first use the proxy prefers accounts below `management.stickyUsageThreshold` (default **95**, valid range greater than 0 through 100), then minimizes applicable cloud utilization / 100 plus active requests / account concurrency limit. Equal scores use a deterministic tie-break. Subsequent requests retain the preferred account even when another account becomes less loaded.

When an applicable window reaches the threshold and a below-threshold account is available, the binding moves permanently. Missing, disabled or login-required preferred accounts also cause reassignment. Full concurrency slots, cooldown, stale quota and reconnect operations use an available account temporarily while retaining the original preference. Existing streams never move. If all available accounts are above the rotation threshold but still below their hard quota limit, the proxy continues using available quota rather than introducing a new 95% rejection boundary. It avoids repeated rotation among those accounts. When no eligible account exists the normal 503 response applies.

Anthropic evaluates 5-hour, weekly and applicable Opus/Sonnet windows; Gemini uses the cloud bucket for the requested model. Quota remains entirely cloud-derived. The 95% threshold does not guarantee a large generation will fit in the remaining quota. Gemini's existing unknown/stale quota policy still applies.

Bindings are stored in SQLite with a hashed source IP and survive process restarts and API key secret rotation. Hashing is not anonymization. Bindings expire after 30 days without successful admission, and are removed when their key or preferred account is deleted. Temporary fallbacks refresh the original binding's activity timestamp. Changing models within one key/IP/provider shares the same binding; a model-specific quota can therefore rotate that provider binding.

There is no unbounded waiting queue. Caller/global saturation returns 429; no eligible account or draining returns 503. Both include `Retry-After: 5`. The default maximum of 64 request bodies being read and 16 MiB per body bounds admission memory; tune these with the global concurrency limit. Request upload timeout is two minutes and is separate from the one-hour upstream idle timeout.

Real upstream 429s cool the selected account for `Retry-After` when provided (otherwise 60 seconds). Authentication failures also briefly remove it from selection. The proxy does not replay a generation on another account: an existing stream is never moved mid-response. The next request may choose another account in the same provider. The existing Anthropic one-time OAuth refresh/retry remains intact.

Slots are released exactly once on response finish or disconnect. Gemini requests now propagate caller cancellation upstream, pause reads for downstream backpressure, and coordinate credential refresh per account. Gemini's existing format-conversion logic remains in place; this is not a rewrite of its event semantics. Anthropic retains the original byte-preserving `pipeline`.

## Administration API

All routes below are on the console listener, not the inference listener. Mutations require `X-Proxy-Admin: 1` and a JSON object for create/update. Browser requests must be same-origin.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/admin/status` | Listener addresses/ports, uptime, active/maximum requests, accounts, keys, operational reports |
| GET | `/admin/keys`, `/admin/keys/:id` | Read key metadata; never the secret or digest |
| POST | `/admin/keys` | Create `{name, app, providers, sourceIps, maxConcurrent, enabled}`; returns secret once |
| PATCH | `/admin/keys/:id` | Update metadata/scopes/limits or revoke with `enabled: false` |
| POST | `/admin/keys/:id/rotate` | Replace secret; returns replacement once |
| DELETE | `/admin/keys/:id` | Delete key; keep historical traffic |
| GET | `/admin/accounts`, `/admin/accounts/:id` | Read account state and latest cloud quota |
| POST | `/admin/accounts` | Create `{name, provider, credentialsPath, project?, maxConcurrent, enabled}` |
| PATCH | `/admin/accounts/:id` | Update account or disable for draining |
| DELETE | `/admin/accounts/:id` | Delete drained account registration |
| POST | `/admin/logins` | Start guided Anthropic login `{name, maxConcurrent?}` |
| GET | `/admin/logins/:id` | Read transient login state and provider authorization link |
| POST | `/admin/logins/:id/code` | Submit `{code}` to the waiting CLI |
| POST | `/admin/logins/:id/verify` | Retry cloud verification after a temporary failure |
| DELETE | `/admin/logins/:id` | Cancel login and remove its staged profile |
| POST | `/admin/accounts/:id/reconnect` | Stage a replacement login for an idle Anthropic account |
| POST | `/admin/accounts/:id/refresh` | Request a throttled cloud quota refresh |
| GET | `/admin/accounts/:id/usage` | Recent cloud quota snapshots |

## Migration and operation

1. Back up the deployed source/configuration and credentials separately in private storage.
2. Start the managed instance on separate ports. Register real accounts and confirm fresh cloud quota readings. Create app keys and configure callers for the new listener.
3. Validate both providers with representative streaming/tool sessions, then tune concurrency against observed 429s and application demand. Offline concurrency tests do not establish a safe provider capacity.
4. Switch clients deliberately. Existing clients without keys are rejected by managed mode.
5. For systemd, allow requests to drain on shutdown: set an adequate `TimeoutStopSec` (for example 3660 seconds for a one-hour idle timeout). Node waits for active responses, but a shorter external supervisor stop deadline can still kill them. Do not restart the production service during this development validation.

State is stored in `data/proxy.sqlite` with mode 0600, and the directory is created with mode 0700. Keep it private and back it up while the process is stopped or using SQLite's backup tooling. The database and private configurations are gitignored. One database/process is supported; independent replicas do not share concurrency accounting. Status shows this proxy's own listeners and runtime state, not arbitrary systemd services or host-wide ports.

Run `npm test` for offline regression/integration tests. Test servers use ephemeral loopback ports and synthetic credentials; they do not start or restart the production service.
