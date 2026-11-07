import { beforeAll, describe, expect, it } from "vitest";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import {
	assertExactLines,
	buildBackendPairFromOneProgramImage,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

const expected = ["receiver-fields PASS"];

describe("declared fields defined by a construct receiver's creation", () => {
	let compiled: string;
	let interpreted: string;
	let sumSource = "";

	beforeAll(() => {
		const pair = buildBackendPairFromOneProgramImage({
			fixture: "tests/local/receiver-fields.js",
			name: "receiver-fields",
		});
		({ compiled, interpreted } = pair);
		const image = pair.programImage;
		const index = image.runtime.functions.findIndex(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "sum",
		);
		sumSource = emitCompiledFunction(
			image.native.functions[index]!,
			index,
			"",
			false,
		)!.source;
	}, 600_000);

	it("creates an inlined construction's receiver with its declared fields", () => {
		expect(sumSource).toContain("mal_vm_op_create_base_construct_receiver_fields(");
	});

	it("matches field definition semantics on both backends", () => {
		assertExactLines(runToStdout(compiled), expected);
		assertExactLines(runToStdout(interpreted), expected);
	});

	it("keeps the defined fields under collection stress", () => {
		assertExactLines(runToStdout(compiled, { env: STRESS_ENV }), expected);
	});
});
