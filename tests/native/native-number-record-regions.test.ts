import { beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const kernels = ["stepParticle", "mixBits", "grows"];
const expected = ["native-number-record-regions PASS"];

describe("native number record regions", () => {
	let compiled: string;
	let interpreted: string;
	const emittedKernels = new Map<string, string>();

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/native-number-record-regions.js",
			name: "native-number-record-regions",
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		for (const [index, fn] of image.runtime.functions.entries()) {
			const name = String.fromCharCode(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			);
			if (!kernels.includes(name)) continue;
			const native = image.native.functions[index]!;
			expect(native.storage!.numberRecordRegions).toHaveLength(1);
			emittedKernels.set(name, emitCompiledFunction(native, index, "", false)!.source);
		}
	}, 600_000);

	it.each(kernels)("admits %s through one receiver guard", (name) => {
		const source = emittedKernels.get(name)!;
		expect(source.match(/mal_vm_number_record_begin\(/g)).toHaveLength(1);
		expect(source).toContain("mal_vm_number_record_store_slow(");
	});

	it("matches array-slot reference arithmetic and every declined receiver", () => {
		assertExactLines(runToStdout(compiled), expected);
	});

	it("holds no heap state across an admitted region under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
