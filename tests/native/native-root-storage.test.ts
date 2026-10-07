import { beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

describe("compact native shadow roots", () => {
	let compiled: string;
	let interpreted: string;
	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-root-storage.js",
			name: "native-root-storage",
		});
		({ compiled, interpreted } = pair);
		const kernel = pair.programImage.native.functions.find(
			(fn) =>
				String.fromCharCode(
					...(pair.programImage.runtime.stringConstants[fn.body.nameStringIndex] ?? []),
				) === "compactRoots",
		)!;
		expect(kernel).toBeDefined();
		expect(kernel.storage!.rootSlotCount).toBeLessThan(
			kernel.storage!.rootRegisters.length,
		);
		expect(emitCompiledFunction(kernel, kernel.functionIndex, "", false)).not.toBeNull();
	}, 600_000);

	it.each(["compiled", "interpreted"])(
		"preserves disjoint, joined and exceptional roots with collecting accessors when %s",
		(backend) => {
			const binary = backend === "compiled" ? compiled : interpreted;
			for (const mode of [{}, STRESS_ENV])
				assertExactLines(runToStdout(binary, { env: { MAL_HOST_GC: "1", ...mode } }), [
					"native-root-storage PASS",
				]);
		},
	);
});
