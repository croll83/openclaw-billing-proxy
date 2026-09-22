#!/usr/bin/env bash
# Run on the proxy host as the service user. Restores code/config/unit, not OAuth credentials.
set -eu
archive="${ROLLBACK_ARCHIVE:-$HOME/backups/hermes-billing-proxy/live-before-fixes-20260922T094040Z.tar.gz}"
expected=cbea601217f28fbacc5f51daa024c33723910b3f11aa246cc7b9bf1aba5d8a54
test -f "$archive"
printf '%s  %s\n' "$expected" "$archive" | sha256sum --check --status
systemctl --user stop hermes-billing-proxy
tar -xzf "$archive" -C "$HOME"
override="$HOME/.config/systemd/user/hermes-billing-proxy.service.d/90-anthropic-fixes-20260922.conf"
if [ -f "$override" ]; then unlink "$override"; fi
systemctl --user daemon-reload
systemctl --user start hermes-billing-proxy
systemctl --user is-active hermes-billing-proxy
