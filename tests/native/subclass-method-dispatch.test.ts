import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
} from "../../src/test-harness.ts";

describe("subclass method dispatch", () => {
	const fixture = "tests/local/subclass-method-dispatch.js";
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-subclass-dispatch-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));

	it("guards subclass overrides and recursive methods, falling back when they change", () => {
		const expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "subclass-method-dispatch",
			config: resolveBuildConfig({}),
			mainFile: HOST_MAIN,
			outDir,
		});
		const functionNamed = (name: string) =>
			pair.programImage.runtime.functions.findIndex(
				(fn) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[fn.nameStringIndex] ?? []),
					) === name,
			);
		const guardedTargets = (caller: number) => {
			const native = pair.programImage.native.functions[caller]!;
			return new Set([
				...native.instructions.flatMap((instruction) =>
					instruction?.kind === "call" ? (instruction.guardedFunctionIndices ?? []) : [],
				),
				...native.body.instructions.flatMap((op) =>
					op.opcode === "GUARD_FUNCTION_INDEX" ? [op.functionIndex] : [],
				),
			]);
		};
		expect(guardedTargets(functionNamed("total")).size).toBeGreaterThan(1);
		const size = functionNamed("size");
		expect(guardedTargets(size).has(size)).toBe(true);
		expect(runToStdout(pair.compiled)).toBe(expected);
		expect(runToStdout(pair.interpreted)).toBe(expected);
	});
});
