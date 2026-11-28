import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("forwards and consumes record results through direct entries under GC stress", () => {
	const fixture = "tests/local/record-result-forwarding.mjs";
	const outDir = mkdtempSync(join(tmpdir(), "mal-record-forwarding-"));
	try {
		const { compiled, interpreted, programImage } = buildBackendPairFromOneProgramImage({
			fixture,
			name: "record-result-forwarding",
			outDir,
			// Keep exact call targets available as in a default CLI build.
			config: resolveBuildConfig({ engine: { eval: false } }),
			nativeStackRoots: "precise",
		});
		const recordEntry = (name: string) => {
			const fn = programImage.native.functions.find(
				(candidate) =>
					String.fromCharCode(
						...(programImage.runtime.stringConstants[candidate.body.nameStringIndex] ??
							[]),
					) === name,
			);
			const entry = fn?.directEntries.find((entry) => entry.resultFields);
			if (fn === undefined || entry === undefined)
				throw new Error(`no record entry for ${name}`);
			return { fn, entry };
		};
		const producer = recordEntry("scanToken");
		const scanner = {
			functionIndex: producer.fn.functionIndex,
			entryId: producer.entry.id,
		};
		for (const name of ["forwardToken", "uppercaseToken"]) {
			const { fn, entry } = recordEntry(name);
			const call = entry.storage?.callTransports.find((call) =>
				call.targets.some(
					(target) =>
						target.functionIndex === scanner.functionIndex &&
						target.entryId === scanner.entryId,
				),
			);
			expect(call, name).toBeDefined();
			expect(fn.recordCalls, name).toContainEqual(
				expect.objectContaining({ callIp: call!.instructionIp }),
			);
			expect(
				entry.resultFields?.forwards?.some(
					(forward) => forward.callIp === call!.instructionIp,
				) ?? false,
				name,
			).toBe(name === "forwardToken");
		}
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		for (const binary of [compiled, interpreted]) {
			expect(runToStdout(binary)).toBe(expected);
			expect(runToStdout(binary, { env: STRESS_ENV })).toBe(expected);
		}
	} finally {
		rmSync(outDir, { recursive: true, force: true });
	}
});
