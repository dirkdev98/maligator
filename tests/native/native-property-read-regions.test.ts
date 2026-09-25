import { beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const kernels = [
	{ name: "readThree", loads: 3 },
	{ name: "readEight", loads: 8 },
	{ name: "readDetachedOwn", loads: 3 },
	{ name: "readThreeInTry", loads: 3 },
	{ name: "readMixed", loads: 3 },
	{ name: "readSameShape", loads: 3 },
	{ name: "readInheritedMutation", loads: 3 },
	{ name: "readPrototypeMutation", loads: 3 },
	{ name: "readAccessorMutation", loads: 3 },
	{ name: "readStorageMutation", loads: 3 },
	{ name: "readProxy", loads: 3 },
];
const expected = ["native-property-read-regions PASS"];
const hostGc = { MAL_HOST_GC: "1" };
const verificationEnv = {
	...hostGc,
	// Reentrant edges force collection even when sanitizer instrumentation is active.
	...(process.env.MAL_ASAN === "1" || process.env.MAL_UBSAN === "1"
		? { MAL_GC_VERIFY: "1" }
		: STRESS_ENV),
};

describe("native property read region continuations", () => {
	let compiled: string;
	let interpreted: string;
	const emittedKernels = new Map<string, string>();

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-property-read-regions.js",
			name: "native-property-read-regions",
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		for (const [index, fn] of image.runtime.functions.entries()) {
			const name = String.fromCharCode(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			);
			if (!kernels.some((kernel) => kernel.name === name)) {
				continue;
			}
			const output = emitCompiledFunction(
				fn,
				image.native.functions[index]!,
				index,
				"",
				false,
			)?.source;
			expect(output).toBeDefined();
			emittedKernels.set(name, output!);
		}
	}, 600_000);

	it.each(kernels)("executes an emitted region for $name", ({ name, loads }) => {
		const output = emittedKernels.get(name);
		expect(output).toBeDefined();
		expect(output!.match(/mal_vm_property_read_region_begin\(/g)).toHaveLength(1);
		expect(output!.match(/mal_vm_property_read_region_try_load\(/g)).toHaveLength(loads);
	});

	it("preserves data admission, mutation, Proxy order, and the original throw continuation", () => {
		assertExactLines(runToStdout(compiled, { env: hostGc }), expected);
	});

	it("publishes heap-valued prior results before collecting region continuations", () => {
		assertExactLines(runToStdout(compiled, { env: verificationEnv }), expected);
	});

	it("matches the interpreted property and exception semantics", () => {
		assertExactLines(runToStdout(interpreted, { env: hostGc }), expected);
	});

	it("preserves interpreted roots at the same explicit collecting edges", () => {
		assertExactLines(runToStdout(interpreted, { env: verificationEnv }), expected);
	});
});
