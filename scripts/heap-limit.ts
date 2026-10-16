import { spawnSync } from "node:child_process";
import { getHeapStatistics } from "node:v8";

// Compiler graphs and generated C can exceed Node's default heap on smaller hosts.
export function requireHeapLimit(megabytes: number): void {
	if (getHeapStatistics().heap_size_limit >= megabytes * 2 ** 20) return;
	const result = spawnSync(
		process.execPath,
		[...process.execArgv, `--max-old-space-size=${megabytes}`, ...process.argv.slice(1)],
		{ stdio: "inherit" },
	);
	process.exit(result.status ?? 1);
}
