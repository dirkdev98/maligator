import { spawnSync } from "node:child_process";
import { getHeapStatistics } from "node:v8";

/**
 * Re-run this script with at least `megabytes` of old space. A product CLI build
 * keeps the CLI's emitted C while it compiles the compiler again for its worker
 * root, which outgrows the default heap Node sizes from physical memory.
 */
export function requireHeapLimit(megabytes: number): void {
	if (getHeapStatistics().heap_size_limit >= megabytes * 2 ** 20) return;
	const result = spawnSync(
		process.execPath,
		[...process.execArgv, `--max-old-space-size=${megabytes}`, ...process.argv.slice(1)],
		{ stdio: "inherit" },
	);
	process.exit(result.status ?? 1);
}
