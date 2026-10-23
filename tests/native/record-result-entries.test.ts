import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ProgramImage } from "../../src/compiler/target/program-image.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = ["record-result-entries PASS"];

describe("record result entries", () => {
	const outDir = mkdtempSync(join(tmpdir(), "mal-record-results-"));
	let compiled: string;
	let interpreted: string;
	let image: ProgramImage;

	beforeAll(() => {
		({
			compiled,
			interpreted,
			programImage: image,
		} = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/record-result-entries.mjs",
			name: "record-result-entries",
			mainFile: HOST_MAIN,
			outDir,
		}));
	});

	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	const functionNamed = (name: string) => {
		const fn = image.native.functions.find(
			(candidate) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[candidate.body.nameStringIndex] ?? []),
				) === name,
		);
		if (fn === undefined) throw new Error(`no native function ${name}`);
		return fn;
	};

	it("returns the fields of out-of-line producers to field-reading callers", () => {
		for (const producer of ["scan", "describe", "classify", "depth"])
			expect(
				functionNamed(producer).directEntries.some((entry) => entry.resultFields),
				producer,
			).toBe(true);
		expect(
			functionNamed("classify").directEntries.find((entry) => entry.resultFields)!
				.resultFields!.allocationIps,
		).toHaveLength(3);
		for (const caller of [
			"tokenLengths",
			"digitCount",
			"describeAll",
			"guarded",
			"depth",
		])
			expect(functionNamed(caller).recordCalls?.length ?? 0, caller).toBeGreaterThan(0);
		// Callers that keep the object need the ordinary entry and its fresh allocation.
		expect(functionNamed("retainAll").recordCalls).toBeUndefined();
	});

	it("enters the record entries at run time", () => {
		const result = spawnSync(compiled, [], {
			encoding: "utf8",
			env: { ...process.env, MAL_PERF_STATS: "1" },
		});
		expect(result.status, result.stderr || result.stdout).toBe(0);
		const hits = Number(/direct_entry_hits=(\d+)/.exec(result.stderr)?.[1] ?? -1);
		expect(hits).toBeGreaterThan(0);
	});

	for (const [backend, binary] of [
		["compiled", () => compiled],
		["interpreted", () => interpreted],
	] as const)
		it(`${backend} keeps record identity, exceptions and heap fields under GC stress`, () => {
			assertExactLines(
				runToStdout(binary(), { env: { MAL_HOST_GC: "1", ...STRESS_ENV } }),
				expected,
			);
		});
});
