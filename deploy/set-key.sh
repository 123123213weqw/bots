#!/usr/bin/env bash
# Replace the bot's DeepSeek key without ever echoing it.
#
#   ssh host
#   cd ~/bots && ./deploy/set-key.sh          # then paste the key and press Ctrl-D
#
# Why not `echo KEY >> .env`: that puts the secret in ~/.bash_history, in the
# process table (visible to every user via ps) and in the terminal scrollback.
# This reads from stdin in quiet mode, writes atomically, then verifies with the
# doctor instead of printing anything.
set -euo pipefail

ENV_FILE="${ENV_FILE:-$HOME/bots/.env}"
[[ -f "$ENV_FILE" ]] || { echo "no $ENV_FILE"; exit 1; }

printf 'Paste the new DeepSeek key, then Ctrl-D (input is not echoed): ' >&2
# -s: no echo. -r: keep backslashes as typed.
IFS= read -rs KEY || true
echo >&2

# Trim surrounding whitespace and CR (a pasted key often carries one).
KEY="${KEY#"${KEY%%[![:space:]]*}"}"
KEY="${KEY%"${KEY##*[![:space:]]}"}"
KEY="${KEY%$'\r'}"

if [[ -z "$KEY" ]]; then
  echo "empty input, nothing changed" >&2
  exit 1
fi
if [[ ${#KEY} -lt 20 ]]; then
  echo "that looks too short (${#KEY} chars), refusing" >&2
  exit 1
fi

# Write to a temp file with the same permissions, then move it into place, so an
# interrupted run can never leave a half-written .env behind.
TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
trap 'rm -f "$TMP"' EXIT
umask 077
grep -v '^DEEPSEEK_API_KEY=' "$ENV_FILE" > "$TMP" || true
printf 'DEEPSEEK_API_KEY=%s\n' "$KEY" >> "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$ENV_FILE"
trap - EXIT

echo "updated $ENV_FILE (key length ${#KEY})" >&2
echo "verifying... (no secret is printed)" >&2
NODE="${NODE:-$HOME/bots/.node}"
"$NODE" "$HOME/bots/dist/doctor.js"
