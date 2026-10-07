import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	deserializeRuntimeImage,
	serializeRuntimeImage,
} from "../src/compiler/target/program-image-codec.ts";
import type { BytecodeFunction } from "../src/compiler/target/runtime-image.ts";

function shapeImage() {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			`function shapeBranches(flag, input) {
				let total = 0;
				let object;
				if (flag) {
					object = { left: input };
					globalThis.left = object;
					total = object.left;
					if (input) {
						object = { inner: input };
						globalThis.inner = object;
						total += object.inner;
					}
				} else {
					object = { right: input };
					globalThis.right = object;
					total = object.right;
				}
				const tail = { after: input };
				globalThis.after = tail;
				return total + tail.after;
			}
			globalThis.keep = shapeBranches;`,
			"native-literal-shape-layout.js",
		),
	);
}

function allocations(fn: BytecodeFunction) {
	return fn.instructions.flatMap((instruction) =>
		instruction.opcode === "CREATE_OBJECT_SHAPED" ? [instruction] : [],
	);
}

describe("shared literal shapes across independent target layouts", () => {
	it("preserves allocation identities through scheduling and both serialized products", () => {
		const image = shapeImage();
		const functionIndex = image.native.functions.findIndex(
			(fn) => allocations(fn.body).length === 4,
		);
		expect(functionIndex).toBeGreaterThanOrEqual(0);
		const portable = allocations(image.runtime.functions[functionIndex]!);
		const native = allocations(image.native.functions[functionIndex]!.body);
		expect(native.map((instruction) => instruction.keyStringIndices)).not.toEqual(
			portable.map((instruction) => instruction.keyStringIndices),
		);
		const descriptors = image.runtime.precompiledLiteralShapes.filter(
			(shape) => shape.functionIndex === functionIndex,
		);
		expect(descriptors).toHaveLength(4);
		for (const target of [portable, native]) {
			for (const allocation of target) {
				expect(
					descriptors.find(
						(shape) => shape.shapeCacheIndex === allocation.shapeCacheIndex,
					)?.keyStringIndices,
				).toEqual(allocation.keyStringIndices);
			}
		}
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(allocations(restored.native.functions[functionIndex]!.body)).toEqual(native);
		expect(allocations(restored.runtime.functions[functionIndex]!)).toEqual(portable);
		expect(
			allocations(
				deserializeRuntimeImage(serializeRuntimeImage(image.runtime)).functions[
					functionIndex
				]!,
			),
		).toEqual(portable);
	});

	it("rejects duplicate allocation identities and descriptors with different keys", () => {
		const image = shapeImage();
		const functionIndex = image.native.functions.findIndex(
			(fn) => allocations(fn.body).length === 4,
		);
		const fn = image.native.functions[functionIndex]!;
		const shapes = allocations(fn.body);
		for (const swap of [false, true]) {
			const malformed = {
				...image,
				native: {
					...image.native,
					functions: image.native.functions.with(functionIndex, {
						...fn,
						body: {
							...fn.body,
							instructions: fn.body.instructions.map((instruction) =>
								swap && instruction === shapes[0]
									? { ...instruction, shapeCacheIndex: shapes[1]!.shapeCacheIndex }
									: instruction === shapes[1]
										? {
												...instruction,
												shapeCacheIndex: shapes[0]!.shapeCacheIndex,
												keyStringIndices: swap
													? instruction.keyStringIndices
													: shapes[0]!.keyStringIndices,
											}
										: instruction,
							),
						},
					}),
				},
			};
			expect(() => serializeCompilerArtifact(malformed)).toThrow(
				swap ? /literal shape descriptor/ : /invalid literal shape index/,
			);
		}
	});
});
