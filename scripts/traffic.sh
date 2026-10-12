#!/usr/bin/env bash
# Generates a little ingress traffic for each lane so there is something to shoot.
# Usage: scripts/traffic.sh [seconds]   (Ctrl-C to stop)
set -u
dur=${1:-300}
end=$((SECONDS + dur))
pids=()
cleanup() { kill "${pids[@]}" 2>/dev/null; }
trap cleanup EXIT INT TERM

ping -i 0.5 1.1.1.1 >/dev/null 2>&1 & pids+=($!)
ping -i 0.7 9.9.9.9 >/dev/null 2>&1 & pids+=($!)

while ((SECONDS < end)); do
	curl -s -o /dev/null --max-time 5 https://example.com &
	curl -s -o /dev/null --max-time 5 http://neverssl.com &
	curl -s -o /dev/null --max-time 5 --http3-only https://cloudflare-quic.com 2>/dev/null &
	getent hosts "r$RANDOM.example.org" >/dev/null &
	sleep 1
done
