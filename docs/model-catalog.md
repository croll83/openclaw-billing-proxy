# Model catalog and latest aliases (managed mode, 2.4.0)

Use the same caller API key as inference. Catalog results respect its provider
permissions and source-IP rules. No account credentials are returned.

- `GET /v1/models?provider=anthropic` returns `{object:"list", data:[...]}`.
- `GET /v1/models/latest?provider=anthropic&family=sonnet` resolves one recommendation.
- `GET /v1/models/latest?provider=gemini&family=argon` resolves Argon.
- Provider is optional on the list; family can filter either endpoint.
- Latest requires both provider and family. Unknown families return 404;
  unauthorized providers return 403; missing or invalid caller keys return 401.

Initial recommendations (operator policy dated 2026-10-20):

| Provider | Family | Alias | Concrete model |
|---|---|---|---|
| anthropic | fable | fable-latest | claude-fable-5-1 |
| anthropic | opus | opus-latest | claude-opus-5-5 |
| anthropic | sonnet | sonnet-latest | claude-sonnet-5-5 |
| anthropic | haiku | haiku-latest | claude-haiku-5-5 |
| gemini | gemini | gemini-latest | gemini-3.8-flash-medium |
| gemini | argon | argon-latest | gemini-4-argon-medium |

`latest` is an explicit recommendation, **not** a lexical version sort, cheapest
model selection, or automatic adoption of new releases. Operators update the
mapping in the console's Model catalog section. Unknown families return 404; add them only once their concrete model ID is verified.
Fable ID verified against https://platform.claude.com/docs/en/models/fable-5-1/overview.

The catalog includes configured recommendations and Gemini model IDs observed in
recent cloud quota metadata. It is not an exhaustive inventory of every model
sold by a provider. Anthropic recommendations have availability `unknown` because
its usage endpoint does not list models. Gemini recommendations are `observed` or
`not_observed` when a fresh nonempty cloud model list exists. Resolving an absent
recommendation returns 503 rather than switching family. No current cloud list
means availability `unknown`; catalog resolution does not guarantee quota,
account eligibility or successful inference.

## Inference

```json
{"model":"sonnet-latest","max_tokens":1024,"messages":[{"role":"user","content":"Hello"}],"stream":true}
```

Send to `/v1/messages`. `claude-sonnet-latest` is also accepted. Concrete model IDs
retain their existing behavior and are not restricted to this catalog.

For Gemini use native routes:

```
POST /v1beta/models/argon-latest:streamGenerateContent?alt=sse
POST /v1beta/models/gemini-latest:generateContent
```

`/models/` and `/v1/models/` prefixes are also accepted. API keys may use
`x-api-key`, Bearer, or `x-goog-api-key` on those native routes. Alias resolution
rewrites the route/model only, preserving native contents, tool signatures and
streaming. Antigravity does not support the old converted inference routes.

Aliases resolve once at request admission, before account selection and quota
checks. Updating a recommendation affects subsequent requests, including the
next turn of an existing conversation. Clients needing a fixed model/signature
compatibility across turns should resolve once and pin the concrete ID for that
conversation. There is no automatic retry or cross-provider fallback.

## Management and storage

`PUT /admin/models`, with the console's existing Host/Origin checks and
`x-proxy-admin: 1`, accepts `{provider, family, id}`. It upserts a recommendation.
Changes persist in SQLite's `model_recommendations` table across restarts; seeds
never overwrite an existing recommendation. Model IDs must be concrete and match
the provider. Setting an alias to another alias is rejected.

`GET /admin/status` includes `models` and seven-day `modelTraffic`. The existing
request history gains nullable `requestedModel`; `model` stores the resolved ID.
Old rows remain intact and reports use their model as the requested ID. Existing
keys, accounts, affinities and request records are preserved by additive schema
migration. Back up the database before upgrading.
