import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { nativeEntryLookup } from "../../src/compiler/target/lower-native-calls.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const fixture = "tests/local/native-resumable-transport.js";
const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-resumable-transport-"));
afterAll(() => rmSync(outDir, { recursive: true, force: true }));

describe("selected native transports across coroutine suspension", () => {
	let compiled: string, interpreted: string, expected: string;
	beforeAll(() => {
		expected = execFileSync(process.execPath, [fixture], { encoding: "utf8" });
		const pair = buildBackendPairFromOneProgramImage({
			fixture,
			name: "native-resumable-transport",
			outDir,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
			mainFile: HOST_MAIN,
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		const entries = nativeEntryLookup(image.native.functions);
		const targets = new Set(image.native.functions.map((fn) => fn.functionIndex));
		const named = (name: string) =>
			image.native.functions.find(
				(native) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[native.body.nameStringIndex] ?? []),
					) === name,
			)!;
		for (const name of ["generator", "asynchronous", "stream"]) {
			const caller = named(name);
			expect(caller, name).toBeDefined();
			const transfer = caller.body.instructions.findIndex(
				(op) => op.opcode === "YIELD" || op.opcode === "AWAIT",
			);
			expect(
				caller.storage!.callTransports.some((plan) => plan.instructionIp > transfer),
			).toBe(true);
			expect(
				caller.storage!.callbackTransports.some((plan) => plan.instructionIp > transfer),
			).toBe(true);
			expect(
				emitCompiledFunction(
					caller,
					caller.functionIndex,
					"",
					false,
					"static",
					targets,
					[],
					entries,
				),
				name,
			).not.toBeNull();
		}
		for (const name of ["generatorFields", "asynchronousFields"]) {
			const caller = named(name);
			expect(caller.fieldCalls, name).toHaveLength(1);
			expect(
				caller.storage!.callTransports.some((plan) =>
					plan.targets.some((target) => target.fields.length > 0),
				),
			).toBe(true);
			expect(
				emitCompiledFunction(
					caller,
					caller.functionIndex,
					"",
					false,
					"static",
					targets,
					[],
					entries,
				),
				name,
			).not.toBeNull();
		}
	}, 600_000);
	it("preserves typed calls, callback misses, snapshots, collecting accessors and resumed throws", () => {
		for (const binary of [compiled, interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(
					runToStdout(binary, {
						env: { MAL_HOST_GC: "1", ...stress },
						timeoutMs: 60_000,
					}),
				).toBe(expected);
	});
});
