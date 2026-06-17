#!/usr/bin/env bash
# Build each benchmark fixture twice — with the native overlay (emit-c, the
# default) and forced through the bytecode interpreter (emit-vm, --no-compiled)
# — then compare both against Node with hyperfine.
#
# Usage: bench/run.sh [name ...]   (default: all fixtures in bench/)
set -euo pipefail
cd "$(dirname "$0")/.."

BENCHES=("$@")
if [ ${#BENCHES[@]} -eq 0 ]; then
	BENCHES=(loops objects intrinsics alloc)
fi

for name in "${BENCHES[@]}"; do
	src="bench/$name.js"
	echo "### building $name"
	node src/index.ts "$src" --name "$name-c" >/dev/null 2>&1
	node src/index.ts "$src" --name "$name-vm" --no-compiled >/dev/null 2>&1
	compiled=$(/usr/bin/grep -ac '^static MalValue mal_compiled_' ".cache/local/$name-c.c" || true)
	echo "    compiled functions in emit-c: $compiled"
done

echo
for name in "${BENCHES[@]}"; do
	echo "## $name"
	hyperfine --warmup 2 -N \
		"node bench/$name.js" \
		".cache/local/$name-c" \
		".cache/local/$name-vm" \
		2>&1 | grep -E 'Benchmark|Time|ran|faster' || true
	echo
done
