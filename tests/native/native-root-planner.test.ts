import { mkdtempSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("native-host physical root planner", () => {
	const outDir = mkdtempSync(path.join(os.tmpdir(), "mal-native-root-planner-"));
	afterAll(() => rmSync(outDir, { recursive: true, force: true }));
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-root-planner.js",
			name: "native-root-planner",
			mainFile: HOST_MAIN,
			outDir,
		});
		({ compiled, interpreted } = pair);
		for (const name of [
			"selectNativeRootStorage",
			"lowerNativeSuspension",
			"nativeInactiveRootMasks",
			"nativeRootMaskWordHex",
		]) {
			const planner = pair.programImage.native.functions.find(
				(native) =>
					String.fromCharCode(
						...(pair.programImage.runtime.stringConstants[native.body.nameStringIndex] ??
							[]),
					) === name,
			)!;
			expect(planner, name).toBeDefined();
			expect(
				emitCompiledFunction(planner, planner.functionIndex, "", false),
				name,
			).not.toBeNull();
		}
	}, 600_000);

	it.each(["compiled", "interpreted"])(
		"preserves root boundaries, collision rejection and growing suspension transports when %s",
		(backend) => {
			const binary = backend === "compiled" ? compiled : interpreted;
			for (const env of [{}, STRESS_ENV])
				assertExactLines(runToStdout(binary, { env }), ["native-root-planner PASS"]);
		},
	);
});
