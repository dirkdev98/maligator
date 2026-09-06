import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseCompilerCapture } from "../../src/profile-artifact.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeBinaryResult,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("literal string switch dispatch", () => {
	it("preserves UTF-16 strict selection, fallthrough and loop edges under GC stress", () => {
		const { compiled, interpreted, programImage } = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/string-switch-dispatch.js",
			name: "string-switch-dispatch",
			outDir: mkdtempSync(join(tmpdir(), "mal-string-switch-")),
		});
		expect(
			programImage.native.functions
				.flatMap((fn) => fn.literalSwitches ?? [])
				.some((site) => site.kind === "string"),
		).toBe(true);
		for (const binary of [compiled, interpreted])
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(
				"string-switch-dispatch PASS\n",
			);
	}, 600_000);

	it("records the executed strict comparisons when profiling retains generic dispatch", () => {
		const outDir = mkdtempSync(join(tmpdir(), "mal-string-switch-profile-"));
		const { binaryPath, programImage } = buildNativeBinaryResult({
			fixture: "tests/local/string-switch-dispatch.js",
			name: "string-switch-profile",
			profileEnabled: true,
			environment: { ...process.env, MAL_PERF_STATS: "1" },
			outDir,
		});
		const capture = join(outDir, "capture.bin");
		expect(
			runToStdout(binaryPath, {
				env: {
					MAL_PROFILE_CAPTURE: capture,
					MAL_PROFILE_COMPILER: "1",
					MAL_PROFILE_IDENTITY: "a".repeat(64),
				},
			}),
		).toBe("string-switch-dispatch PASS\n");
		const profile = parseCompilerCapture(readFileSync(`${capture}.compiler`));
		const tagsIndex = programImage.runtime.functions.findIndex(
			(fn) =>
				String.fromCharCode(
					...(programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "tags",
		);
		const fn = programImage.runtime.functions[tagsIndex]!;
		const site = programImage.native.functions[tagsIndex]!.literalSwitches!.find(
			(site) => site.kind === "string",
		)!;
		for (let index = 0; index < site.cases.length - 1; index++) {
			const comparisonSite = fn.profileSiteIds![site.instructionIp + index * 3 + 1]!;
			expect(profile.bySite[comparisonSite]?.executions).toBeGreaterThan(0);
		}
	}, 600_000);
});
