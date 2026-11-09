import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
	buildNativeBinary,
	resolveHarnessExecutionInvocation,
} from "../../src/test-harness.ts";

const directory = mkdtempSync(path.join(tmpdir(), "mal-nursery-budget-"));
let binary: string;
beforeAll(() => {
	binary = buildNativeBinary({
		fixture: "tests/local/fibertest_stub.js",
		name: "gc-nursery-budget",
		mainFile: "tests/fixtures/gc-nursery-budget/main.c",
		outDir: directory,
		evalEnabled: false,
		realmsEnabled: false,
		intlEnabled: false,
		temporalEnabled: false,
		regexpEnabled: false,
	});
});
afterAll(() => rmSync(directory, { recursive: true, force: true }));

it.each([false, true])(
	"bounds transient nursery growth with the optional cap=%s",
	(capped) => {
		const invocation = resolveHarnessExecutionInvocation(binary);
		const result = spawnSync(invocation.executable, invocation.args, {
			encoding: "utf8",
			timeout: 30_000,
			env: {
				...process.env,
				MAL_GC_STRESS: "0",
				MAL_GC_VERIFY: "1",
				MAL_GC_STATS: "1",
				MAL_GC_MEMORY_TRACE: "1",
				MAL_GC_NURSERY_MAX_BYTES: capped ? "4194304" : undefined,
			},
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const fields = result.stdout.match(/headroom=(\d+) collections=(\d+)/)!;
		expect(fields).not.toBeNull();
		if (capped) {
			expect(Number(fields[1])).toBe(4194304);
			expect(Number(fields[2])).toBeGreaterThan(0);
		} else {
			expect(Number(fields[1])).toBeGreaterThan(16 * 1024 * 1024);
			expect(Number(fields[2])).toBe(0);
		}
		const samples = result.stderr
			.split("\n")
			.filter((line) => line.startsWith("[gc-memory]"));
		expect(
			samples.some(
				(line) => line.includes("moment=before") && line.includes("major_complete=0"),
			),
		).toBe(true);
		expect(
			samples.some(
				(line) => line.includes("moment=after") && line.includes("major_complete=1"),
			),
		).toBe(true);
		for (const line of samples) {
			const values = Object.fromEntries(
				[...line.matchAll(/([a-z_]+)=(\d+)/g)].map(
					(match) => [match[1]!, Number(match[2])] as const,
				),
			);
			expect(values.managed_owned_bytes).toBeGreaterThanOrEqual(
				values.managed_large_bytes!,
			);
			expect(values.process_reserved_bytes).toBeGreaterThanOrEqual(
				values.chunk_mapped_bytes!,
			);
		}
	},
);
