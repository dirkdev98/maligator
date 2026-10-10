import { beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = ["module-private-classes PASS"];

describe("private names of module-level classes", () => {
	let compiled: string;
	let interpreted: string;
	let scanSource: string;

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/module-private-classes.mjs",
			name: "module-private-classes",
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		const index = image.runtime.functions.findIndex(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "scan",
		);
		scanSource = emitCompiledFunction(
			image.native.functions[index]!,
			index,
			"",
			false,
		)!.source;
	}, 600_000);

	it("inlines private-field accessors into a caller outside the class", () => {
		expect(scanSource).toContain("mal_vm_private_try_load(");
	});

	it("keeps brands, statics, and per-evaluation names", () => {
		assertExactLines(runToStdout(compiled), expected);
	});

	it("keeps them under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});

	it("matches the interpreted semantics", () => {
		assertExactLines(runToStdout(interpreted), expected);
	});
});
