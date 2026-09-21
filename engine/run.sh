#!/usr/bin/env bash
# Runs the shared Connect engine. First run opens a browser for a one-time
# CData Connect Cloud OAuth login; after that the driver silently refreshes
# the cached token. See README.md.
set -euo pipefail
cd "$(dirname "$0")"

DRIVER_URL="https://maven.cdata.com/p/jdbc/cdata/connect-jdbc/26.0.9676/connect-jdbc-26.0.9676.jar"

if [ ! -f lib/cdata.jdbc.connect.jar ]; then
  echo "Driver jar not found — fetching the canonical build from maven.cdata.com..."
  mkdir -p lib
  curl -fsSL -o lib/cdata.jdbc.connect.jar "$DRIVER_URL"
fi

if [ ! -f target/connect-engine.jar ]; then
  echo "Building (first run)..."
  mvn -q package
fi

mkdir -p .oauth

java -cp "target/connect-engine.jar:lib/cdata.jdbc.connect.jar" com.cdata.hackathon.engine.Main
