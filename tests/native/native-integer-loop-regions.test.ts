import { beforeAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	scaledNativeRunTimeoutMs,
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
	"fusedSteps",
	"scaledSum",
	"capturedSum",
];
const builtinKernels = ["multiplyState", "leadingZeroState"];
const expected = ["native-integer-loop-regions PASS"];

describe.each(["mutable", "locked"] as const)(
	"native safe-integer loop regions with %s primordials",
	(primordials) => {
		let compiled: string;
		let interpreted: string;
		const emittedKernels = new Map<string, string>();

		beforeAll(() => {
			const pair = buildBackendPairFromOneProgramImage({
				fixture: "tests/local/native-integer-loop-regions.js",
				name: `native-integer-loop-regions-${primordials}`,
				config: resolveBuildConfig({ engine: { primordials } }),
			});
			({ compiled, interpreted } = pair);
			const image = pair.programImage;
			for (const [index, fn] of image.runtime.functions.entries()) {
				const name = String.fromCharCode(
					...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
				);
				if (!kernels.includes(name) && !builtinKernels.includes(name)) continue;
				const native = image.native.functions[index]!;
				expect(native.storage!.numericLoopRegions).toHaveLength(
					kernels.includes(name) || primordials === "locked" ? 1 : 0,
				);
				emittedKernels.set(name, emitCompiledFunction(native, index, "", false)!.source);
			}
		}, 600_000);

		it.each(kernels)("admits the loop of %s once per entry", (name) => {
			expect(emittedKernels.get(name)!).toContain("mal_safe_integer_admit(");
		});

		it.each(builtinKernels)("uses the certified builtin identity in %s", (name) => {
			expect(emittedKernels.get(name)?.includes("mal_safe_integer_admit(") ?? false).toBe(
				primordials === "locked",
			);
		});

		it("matches double semantics through every guard", () => {
			assertExactLines(runToStdout(compiled), expected);
		});

		it(
			"returns polled iterations to the original loop under collection stress",
			() => {
				assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
			},
			scaledNativeRunTimeoutMs(undefined, { ...process.env, ...STRESS_ENV }) + 10_000,
		);

		it("matches the interpreted semantics", () => {
			assertExactLines(runToStdout(interpreted), expected);
		});
	},
);
