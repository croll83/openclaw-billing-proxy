# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS login-cli
ARG CLAUDE_VERSION=2.1.293
RUN npm install --prefix /opt/login-cli --omit=dev --no-audit --no-fund \
    "@anthropic-ai/claude-code@${CLAUDE_VERSION}" \
    && rm -rf /root/.npm

COPY package.json /tmp/application-package.json
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('/tmp/application-package.json'));fs.writeFileSync('/opt/application-package.json',JSON.stringify({name:'ai-engine-proxy',version:p.version,private:true,main:p.main,engines:p.engines,license:p.license}));"

# Build the maintained zlib release against bookworm, without adding a compiler
# or packages from another Debian distribution to the runtime image.
FROM node:22-bookworm-slim AS zlib
RUN apt-get update && apt-get install -y --no-install-recommends build-essential curl ca-certificates \
    && curl -fsSL https://github.com/madler/zlib/releases/download/v1.3.2/zlib-1.3.2.tar.gz -o /tmp/zlib.tar.gz \
    && echo "bb329a0a2cd0274d05519d61c667c062e06990d72e125ee2dfa8de64f0119d16  /tmp/zlib.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/zlib.tar.gz -C /tmp \
    && cd /tmp/zlib-1.3.2 && ./configure --shared && make -j2 && make test \
    && mkdir -p /tmp/pkg/DEBIAN /tmp/pkg/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH) /tmp/pkg/usr/share/doc/zlib1g \
    && cp -a libz.so.1 libz.so.1.3.2 /tmp/pkg/lib/$(dpkg-architecture -qDEB_HOST_MULTIARCH)/ \
    && cp LICENSE /tmp/pkg/usr/share/doc/zlib1g/copyright \
    && printf 'Package: zlib1g\nSource: zlib\nVersion: 1:1.3.2-0ai1\nArchitecture: %s\nMaintainer: Image Maintainers <maintainers@example.invalid>\nDescription: compression runtime library\n' "$(dpkg --print-architecture)" > /tmp/pkg/DEBIAN/control \
    && dpkg-deb --build --root-owner-group /tmp/pkg /tmp/zlib.deb

FROM node:22-bookworm-slim
ARG VERSION=2.3.0
LABEL org.opencontainers.image.title="ai-engine-proxy" \
      org.opencontainers.image.version="${VERSION}"
RUN apt-get update && apt-get upgrade -y && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && groupadd --gid 10001 engine \
    && useradd --uid 10001 --gid 10001 --home-dir /data --no-create-home engine \
    && install -d -o 10001 -g 10001 -m 0700 /data \
    && mkdir -p /etc/ai-engine-proxy
COPY --from=zlib /tmp/zlib.deb /tmp/zlib.deb
RUN dpkg -i /tmp/zlib.deb && rm /tmp/zlib.deb
COPY --from=login-cli /opt/login-cli /opt/login-cli
RUN ln -s /opt/login-cli/node_modules/.bin/claude /usr/local/bin/claude
WORKDIR /app
COPY index.js LICENSE ./
COPY --from=login-cli /opt/application-package.json ./package.json
COPY src/ ./src/
COPY web/ ./web/
ENV HOME=/data \
    XDG_CACHE_HOME=/data/.cache \
    XDG_CONFIG_HOME=/data/.config \
    XDG_STATE_HOME=/data/.local/state \
    NPM_CONFIG_CACHE=/data/.npm \
    TMPDIR=/tmp \
    DEBUG_DUMP=0 \
    DISABLE_AUTOUPDATER=1 \
    NODE_OPTIONS=--require=/app/src/container-bootstrap.js
USER 10001:10001
WORKDIR /data
EXPOSE 18802 18803
ENTRYPOINT ["node", "index.js"]
