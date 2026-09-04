import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { buildNativeBinary, runToStdout } from "../../src/test-harness.ts";

const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-gc-owner-counters-"));

describe("GC owner counter hooks", () => {
	let binary: string;

	beforeAll(() => {
		binary = buildNativeBinary({
			fixture: "tests/local/gc-owner-counters.js",
			name: "gc-owner-counters",
			compiled: true,
			outDir,
		});
	});

	it("keeps the hooks out of normal executions", () => {
		expect(runToStdout(binary)).toBe("absent\n");
	});

	it("exposes monotonic allocation and collection snapshots only under GC control", () => {
		const result = spawnSync(binary, [], {
			env: {
				...process.env,
				MAL_GC_STATS: "1",
				MAL_GC_CONTROL: "1",
				MAL_HOST_GC: "1",
			},
			encoding: "utf8",
		});
		expect(result.status, result.stderr).toBe(0);
		const snapshot = JSON.parse(result.stdout) as {
			allocatedBefore: number;
			allocatedAfter: number;
			collectionsBefore: number;
			collectionsAfter: number;
			retained: number;
		};
		expect(snapshot.allocatedAfter).toBeGreaterThan(snapshot.allocatedBefore);
		expect(snapshot.collectionsAfter).toBeGreaterThan(snapshot.collectionsBefore);
		expect(snapshot.retained).toBe(1_000);
	});
});
