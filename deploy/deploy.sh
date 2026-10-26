#!/usr/bin/env bash
# Deploy to a Linux box over SSH, from a machine that already has the repo.
#
#   ./deploy/deploy.sh user@host            # first time and upgrades
#   ./deploy/deploy.sh user@host --no-enable
#
# Assumes: node >= 20 on the target, systemd with a lingering user session
# (`loginctl enable-linger <user>`) so the service survives logout.
#
# Two things this script is careful about:
#   * .env is sent separately and chmod 600, never printed, never in git.
#   * it refuses nothing about other instances, but STOP ANY OTHER RUNNING
#     INSTANCE FIRST: long connections are clustered, not broadcast, so two
#     clients of the same app split events at random and both look healthy.
set -euo pipefail

TARGET="${1:?usage: deploy.sh user@host [--no-enable]}"
ENABLE=1
[[ "${2:-}" == "--no-enable" ]] && ENABLE=0

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE=feishu-bot

cd "$HERE"

echo "==> syncing source to $TARGET:~/bots"
rsync -az --delete \
  --exclude node_modules --exclude .env --exclude .state \
  --exclude dist --exclude .git --exclude __pycache__ --exclude .venv \
  ./ "$TARGET:~/bots/"

# The remote .env is the source of truth once the box is set up: it may hold
# credentials that deliberately never exist locally (an LLM key, for instance).
# Overwriting it on every deploy would silently revoke them, so only send the
# local file when the target has none, or when explicitly asked.
if ssh "$TARGET" "test -f ~/bots/.env"; then
  if [[ "${PUSH_ENV:-0}" == "1" && -f .env ]]; then
    echo "==> PUSH_ENV=1: overwriting remote .env from local"
    rsync -az .env "$TARGET:~/bots/.env"
    ssh "$TARGET" "chmod 600 ~/bots/.env"
  else
    echo "==> keeping remote .env (set PUSH_ENV=1 to overwrite)"
    ssh "$TARGET" "chmod 600 ~/bots/.env"
  fi
elif [[ -f .env ]]; then
  echo "==> no remote .env yet, sending local one (mode 600)"
  rsync -az .env "$TARGET:~/bots/.env"
  ssh "$TARGET" "chmod 600 ~/bots/.env"
else
  echo "!! no .env locally or remotely — the service will fail until one exists"
fi

echo "==> installing dependencies and building on the target"
ssh "$TARGET" "cd ~/bots && npm ci --no-audit --no-fund >/dev/null && npx tsc -p tsconfig.json && echo built: \$(ls dist | tr '\n' ' ')"

# Pick the interpreter for this service only. Default: whatever node is on PATH.
# Override with NODE_BIN=/opt/node-v24.22.1/bin/node to run a newer Node than the
# host's system node (do NOT repoint /usr/local/bin/node on a shared box). The
# symlink keeps bot.service host-independent and makes a switch a one-liner.
NODE_BIN="${NODE_BIN:-}"
if [[ -z "$NODE_BIN" ]]; then
  NODE_BIN="$(ssh "$TARGET" 'command -v node')"
fi
echo "==> interpreter: $NODE_BIN"
ssh "$TARGET" "test -x '$NODE_BIN' || { echo 'not executable: $NODE_BIN'; exit 1; }"
NODE_VERSION="$(ssh "$TARGET" "'$NODE_BIN' -v")"
echo "==> node version: $NODE_VERSION"
ssh "$TARGET" "ln -sfn '$NODE_BIN' ~/bots/.node"

echo "==> installing systemd user units"
ssh "$TARGET" "mkdir -p ~/.config/systemd/user ~/bots/.state \
  && cp ~/bots/deploy/bot.service ~/.config/systemd/user/$SERVICE.service \
  && cp ~/bots/deploy/digest.service ~/.config/systemd/user/digest.service \
  && cp ~/bots/deploy/digest.timer ~/.config/systemd/user/digest.timer \
  && systemctl --user daemon-reload"

if [[ $ENABLE == 1 ]]; then
  ssh "$TARGET" "systemctl --user enable $SERVICE.service"
  # The timer is only meaningful once DIGEST_CHAT_ID exists; skip it politely.
  if ssh "$TARGET" "grep -q '^DIGEST_CHAT_ID=' ~/bots/.env"; then
    ssh "$TARGET" "systemctl --user enable --now digest.timer"
    echo "==> digest timer enabled: $(ssh "$TARGET" 'systemctl --user list-timers digest.timer --no-pager | head -2 | tail -1')"
  else
    echo "!! DIGEST_CHAT_ID not set on the target — digest timer left disabled"
  fi
fi

echo "==> restarting"
ssh "$TARGET" "systemctl --user restart $SERVICE.service && sleep 6 \
  && systemctl --user is-active $SERVICE.service \
  && journalctl --user -u $SERVICE.service --since '-15s' --no-pager | grep -E 'connection ready|fatal' || true"

echo "==> done. logs: journalctl --user -u $SERVICE -f"
