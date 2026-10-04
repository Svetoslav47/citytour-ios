#!/bin/sh
# Runs as root only long enough to make DATA_DIR (a host volume / Render disk, often root-owned when first
# mounted) writable by the unprivileged "node" user, then execs the server as that user.
set -eu
if [ "$(id -u)" = "0" ]; then
  mkdir -p "${DATA_DIR:-/var/data}"
  chown -R node:node "${DATA_DIR:-/var/data}"
  exec su-exec node "$@"
fi
exec "$@"
