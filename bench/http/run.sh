#!/usr/bin/env bash
# HTTP throughput benchmark: maligator (WinterTC Mal.serve, native/emit-c) vs
# Node.js http.createServer. Both are single-threaded event-loop servers
# returning a fixed 13-byte plaintext body with an explicit Content-Length.
#
# Client: oha (multi-threaded, HTTP/1.1 keep-alive) so the load generator is not
# the bottleneck — each server is driven until its own single core saturates.
#
# Usage: bench/http/run.sh [duration] [concurrency-levels...]
#   bench/http/run.sh                 # 10s per level, concurrency 1 8 50 100 200
#   bench/http/run.sh 15s 50 200      # 15s each at concurrency 50 and 200
set -euo pipefail
cd "$(dirname "$0")/.."/..

DURATION="${1:-10s}"
shift || true
CONC=("$@")
if [ ${#CONC[@]} -eq 0 ]; then CONC=(1 8 50 100 200); fi

MAL_PORT=3111
NODE_PORT=3112
MAL_BIN=".cache/local/httpbench-mal"

echo "### building maligator server (native / host event loop)"
node bench/http/build.ts bench/http/server_mal.js httpbench-mal >/dev/null

pkill -f httpbench-mal 2>/dev/null || true
pkill -f server_node.js 2>/dev/null || true
sleep 0.3

MAL_PID=""; NODE_PID=""
cleanup() { [ -n "$MAL_PID" ] && kill "$MAL_PID" 2>/dev/null || true; [ -n "$NODE_PID" ] && kill "$NODE_PID" 2>/dev/null || true; }
trap cleanup EXIT

wait_up() { for _ in $(seq 1 100); do curl -s -o /dev/null "http://127.0.0.1:$1/" && return 0; sleep 0.05; done; echo "port $1 never came up" >&2; exit 1; }

"$MAL_BIN" >/dev/null 2>&1 & MAL_PID=$!
node bench/http/server_node.js >/dev/null 2>&1 & NODE_PID=$!
wait_up "$MAL_PORT"
wait_up "$NODE_PORT"

# Run oha against a server; sample the server's CPU% during the run.
# Prints: "<req/s> <p50ms> <p99ms> <cpuAvg%> <cpuPeak%>"
run_one() { # port pid
	local port=$1 pid=$2 json cpu_sum=0 cpu_n=0 cpu_mx=0 c
	oha -z "$DURATION" -c "$CONC_CUR" --no-tui --output-format json "http://127.0.0.1:$port/" >/tmp/oha.json 2>/dev/null &
	local oha_pid=$!
	while kill -0 "$oha_pid" 2>/dev/null; do
		c=$(ps -o %cpu= -p "$pid" 2>/dev/null | tr -d ' ')
		[ -n "$c" ] && { cpu_sum=$(awk -v s="$cpu_sum" -v c="$c" 'BEGIN{print s+c}'); cpu_n=$((cpu_n+1)); cpu_mx=$(awk -v m="$cpu_mx" -v c="$c" 'BEGIN{print (c>m)?c:m}'); }
		sleep 0.3
	done
	wait "$oha_pid"
	node -e '
		const j=JSON.parse(require("fs").readFileSync("/tmp/oha.json","utf8"));
		const s=j.summary, d=j.latencyPercentiles||{};
		const rps=s.requestsPerSec;
		const p50=(d["p50"]??s.average)*1000, p99=(d["p99"]??0)*1000;
		process.stdout.write(rps.toFixed(0)+" "+p50.toFixed(3)+" "+p99.toFixed(3));
	' <<<"" 2>/dev/null
	awk -v s="$cpu_sum" -v n="$cpu_n" -v mx="$cpu_mx" 'BEGIN{printf " %.0f %.0f", (n>0?s/n:0), mx}'
	echo
}

# warmup both
CONC_CUR=50; oha -z 3s -c 50 --no-tui "http://127.0.0.1:$MAL_PORT/" >/dev/null 2>&1 || true
oha -z 3s -c 50 --no-tui "http://127.0.0.1:$NODE_PORT/" >/dev/null 2>&1 || true

printf '\n%-5s | %22s | %22s | %8s\n' "" "maligator" "node" ""
printf '%-5s | %10s %5s %5s | %10s %5s %5s | %8s\n' "conc" "req/s" "p50" "p99" "req/s" "p50" "p99" "ratio"
printf -- '------+------------------------+------------------------+---------\n'
for c in "${CONC[@]}"; do
	CONC_CUR="$c"
	read -r m_rps m_p50 m_p99 m_cpu m_peak < <(run_one "$MAL_PORT" "$MAL_PID")
	read -r n_rps n_p50 n_p99 n_cpu n_peak < <(run_one "$NODE_PORT" "$NODE_PID")
	ratio=$(awk -v m="$m_rps" -v n="$n_rps" 'BEGIN{ if(n>0) printf "%.2fx", m/n; else print "-"}')
	printf '%-5s | %10s %5s %5s | %10s %5s %5s | %8s\n' "$c" "$m_rps" "$m_p50" "$m_p99" "$n_rps" "$n_p50" "$n_p99" "$ratio"
	printf '%-5s | %10s %5s %5s | %10s %5s %5s | %8s\n' "" "cpu:$m_cpu%/$m_peak%" "" "" "cpu:$n_cpu%/$n_peak%" "" "" ""
done
echo
echo "req/s, p50/p99 latency in ms. cpu = server-process avg/peak %CPU during the run (100% = one core)."
echo "ratio = maligator req/s ÷ node req/s  (>1 = maligator faster)."
