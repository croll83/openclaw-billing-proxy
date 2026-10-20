# Container login CLIs and updates

The linux/amd64 image includes Claude Code and Antigravity (`agy`) in PATH,
readable/executable by UID/GID 10001. Dockerfile defaults for 2.4.1 are Claude Code
2.1.304 and AGY 1.4.3. The publishing workflow resolves the current stable versions
on each build, passes exact versions as build arguments, and verifies the AGY
archive against the SHA-256 digest from the official GitHub release.

Sources:
- https://registry.npmjs.org/@anthropic-ai/claude-code
- https://github.com/google-antigravity/antigravity-cli/releases
- https://antigravity.google/docs/cli/troubleshooting/

The workflow runs on pushes to master, manual dispatch, and daily at 04:23 UTC.
Every run gets a distinct immutable tag:
`<version>-sha-<commit>-run-<github-run-id>`. A rerun of that run preserves its
published artifact. The latest alias is promoted only after tests, container
checks, and the applicable-CRITICAL Trivy gate pass, and only when that commit is
still master. Scan evidence and resolved CLI versions are in the Actions run.

Self-updating binaries inside a running pod is deliberately disabled. Only
`/data` and `/tmp` need to be writable; CLI profiles/cache and lockfiles belong
there, never `/app` or `/usr/local/bin`. Account secrets are mounted/persisted
externally and are not baked into any image layer. Each AGY account uses a
separate HOME with its standard `.gemini/antigravity-cli` credential layout.

The container smoke check starts both CLIs as UID 10001 under read-only root,
checks exact versions, verifies the Claude console login URL flow, and exercises
health, authentication, catalog and nginx-sidecar console access. No CI OAuth
credentials are supplied, so a complete real account renewal is not certified
by that smoke check. Runtime authentication depends on valid credentials and
provider behavior as well as the CLI version. CLI updates do not automatically
update the proxy's independently maintained upstream protocol fingerprints.

Publishing a new image does **not** update an existing EKS deployment. A workload
pinned to a digest keeps that image until its configuration and pods are updated.
The accelerate repository and Terraform variable `ai_engine_proxy_image` are not
modified by this workflow. Adopt the new tested tag/digest there to update the CLI.
