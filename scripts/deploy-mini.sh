#!/bin/sh
# Deploys the web app to the Mac mini that runs Chapu: syncs the working tree
# (code only, never data/), installs dependencies, builds, and restarts the
# launchd service. Run from the repo root on the laptop.
set -eu
# Host details live outside Git: scripts/deploy-mini.env (ignored) or the
# environment. CHAPU_HOST is user@host; CHAPU_SSH_KEY defaults to ~/.ssh/id_ed25519.
[ -f "$(dirname "$0")/deploy-mini.env" ] && . "$(dirname "$0")/deploy-mini.env"
HOST="${CHAPU_HOST:?set CHAPU_HOST=user@host in scripts/deploy-mini.env}"
KEY="${CHAPU_SSH_KEY:-$HOME/.ssh/id_ed25519}"
REMOTE_DIR="${CHAPU_REMOTE_DIR:-message-box-web}"
SSH="ssh -i $KEY -o BatchMode=yes"

rsync -az --delete -e "$SSH" \
  --exclude node_modules --exclude .next --exclude data --exclude .git \
  --exclude 'firmware/esp32/.pio' --exclude 'firmware/esp32/build' \
  --exclude 'firmware/esp32/managed_components' --exclude 'firmware/esp32/bins' --exclude .DS_Store \
  ./ "$HOST:~/$REMOTE_DIR/"

$SSH "$HOST" "export PATH=\$HOME/.local/bin:/opt/homebrew/bin:\$PATH; cd ~/$REMOTE_DIR \
  && npm ci --no-audit --no-fund >/dev/null \
  && npx next build 2>&1 | grep -E 'Compiled|rror' \
  && launchctl kickstart -k gui/\$(id -u)/com.chapu.messagebox \
  && sleep 6 && curl -s localhost:3000/api/whatsapp/status | python3 -c 'import json,sys; s=json.load(sys.stdin); print(\"mini up · authenticated:\", s[\"authenticated\"], \"syncRunning:\", s[\"syncRunning\"])'"
