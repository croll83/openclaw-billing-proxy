# AI Engine Proxy container

The image runs managed mode with the existing JSON config contract. No additional
mandatory config keys are introduced. Keep one replica per SQLite database/PVC.
The management listener must remain on loopback behind the chart's nginx sidecar.
This change does not modify the accelerate repository or existing deployments.

## Build and verify

```sh
docker build --pull --platform linux/amd64 --provenance=false --sbom=false -t ai-engine-proxy:2.3.0 .
npm test
python3 tests/container-smoke.py ai-engine-proxy:2.3.0
trivy image --scanners vuln --severity CRITICAL --exit-code 1 --vex security/container.openvex.json ai-engine-proxy:2.3.0
```

Version 2.3.0 pins the login CLI to 2.1.293, installed in `/opt/login-cli` and
exposed as `claude` in PATH. CLI automatic updating is disabled, including in the
isolated login subprocess. Credentials and profiles are created on the persistent
volume after operator login, never baked into the image. The CLI's dependencies
and license notices are retained alongside it.

The application runs as uid/gid 10001, with `HOME=/data`, `WORKDIR /data`, and
`ENTRYPOINT ["node", "index.js"]`. The chart appends
`--config /etc/ai-engine-proxy/config.json`. A Node preload creates
`/data/index.js -> /app/index.js` so the relative entrypoint works even when a
volume hides the image's `/data`. Existing valid links are reused; an unrelated
existing file is rejected rather than overwritten. Do not override `NODE_OPTIONS`
without retaining `--require=/app/src/container-bootstrap.js`.

`/app` is read-only. Runtime writes are confined to the writable `/data` volume and
`/tmp` mount. The PVC must permit writes by uid/gid 10001 (`fsGroup: 10001`). Cache
locations point into `/data`; debug dumps, if explicitly enabled, use `/tmp`.

The smoke test launches nginx in the application's network namespace, tests both
API key headers, health, missing-key rejection, UI, external Origin rewriting,
CLI authorization-link generation/cancellation, and reuse of the data volume on
restart. It does not authenticate a real subscription or send a generation.
Only its own containers and volume are removed. The test requires Docker and
Python 3 and pulls `nginx:stable-bookworm` for the sidecar.

## Vulnerability assessment

The runtime receives available bookworm package updates at build time. The zlib
stage builds upstream 1.3.2 against bookworm, verifies the archive checksum, runs
its tests and installs only the shared library and license as an explicitly
versioned local package. Build tools are absent from the final image.

Trivy's bookworm advisory for CVE-2023-45853 has no fixed version and flags even
this newer locally built package. It concerns MiniZip, which this build does not
include. `security/container.openvex.json` records the narrowly scoped
`not_affected` assessment for **zlib1g 1:1.3.2-0ai1 only**. See the
[Debian advisory](https://security-tracker.debian.org/tracker/CVE-2023-45853).

On 2026-10-09, Trivy 0.75.0 reported **one raw CRITICAL finding** (that advisory)
and **zero applicable CRITICAL findings with the supplied VEX**. This is not a
claim of an unfiltered zero-finding scan. Other severities are not a release gate.
Re-scan every release; do not add broad severity/status ignore rules.

## Publication

Publish only to the Docker Hub organization and visibility chosen by the owner.
Set the repository visibility before the first push. Check that `2.3.0` does not
already exist; never overwrite a released version tag. Enable version-tag
immutability in Docker Hub where supported, and use the registry digest in EKS.
An optional `latest` tag must reference the same artifact; it is not immutable.

```sh
docker tag ai-engine-proxy:2.3.0 docker.io/ORG/ai-engine-proxy:2.3.0
docker push docker.io/ORG/ai-engine-proxy:2.3.0
```

Record the **registry manifest digest**, not the local image configuration ID.
Publish the already tested image rather than rebuilding between scan and push.
The tested release platform is linux/amd64. The Dockerfile is architecture-aware,
but arm64 must be built, scanned and tested separately before publishing a
multi-platform index.

Only neutral title/version OCI labels are set. The image's application package
metadata is minimized and renamed, and source/provenance attestations are disabled
by the documented build command. This is **neutral branding, not concealment**:
recipients can inspect runtime JavaScript, UI, CLI binaries and required licenses
to determine the implementation and purpose. No Docker packaging technique makes
those files secret from someone who can pull the image.

## Automatic GitHub publication

`.github/workflows/publish-image.yml` runs on every push to `master` or manual
workflow dispatch on that branch, using GitHub-hosted Ubuntu runners. Repository
secrets `DOCKERHUB_USERNAME` and `DOCKERHUB_TOKEN` authorize the Docker Hub push;
no credentials are stored in Git or image layers.

Each commit gets `docker.io/croll83/ai-engine-proxy:VERSION-sha-FULL_COMMIT_SHA`.
The workflow runs Node 22 tests, builds and loads the amd64 image, tests the
read-only container with the nginx sidecar, and applies the documented Trivy/VEX
gate **before** pushing that same artifact. An existing commit tag is reused on
reruns rather than overwritten, and is re-scanned. The registry digest is printed
in the Actions run summary; scan evidence is retained as a workflow artifact.

A separate serialized job updates `latest` only if that run's commit is still the
head of `master`, preventing a slower old build from overwriting a newer release.
Plain version tags such as `2.3.0` are manually released and never rewritten by
this workflow. Changing the package version changes the prefix of future automatic
tags. Do not use `latest` when an immutable deployment reference is required.
