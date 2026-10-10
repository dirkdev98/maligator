import { beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const kernels = [
	"collatzSteps",
	"hashRange",
	"smallestFactor",
	"grows",
	"negativeZero",
	"inexact",
	"remainderByZero",
	"parityRun",
	"bitsUpTo",
];
const expected = ["native-integer-loop-regions PASS"];

describe("native safe-integer loop regions", () => {
	let compiled: string;
	let interpreted: string;
	const emittedKernels = new Map<string, string>();

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-integer-loop-regions.js",
			name: "native-integer-loop-regions",
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		for (const [index, fn] of image.runtime.functions.entries()) {
			const name = String.fromCharCode(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			);
			if (!kernels.includes(name)) continue;
			const native = image.native.functions[index]!;
			expect(native.storage!.integerLoopRegions).toHaveLength(1);
			emittedKernels.set(name, emitCompiledFunction(native, index, "", false)!.source);
		}
	}, 600_000);

	it.each(kernels)("admits the loop of %s once per entry", (name) => {
		expect(emittedKernels.get(name)!).toContain("mal_safe_integer_admit(");
	});

	it("matches double semantics through every guard", () => {
		assertExactLines(runToStdout(compiled), expected);
	});

	it("returns polled iterations to the original loop under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
