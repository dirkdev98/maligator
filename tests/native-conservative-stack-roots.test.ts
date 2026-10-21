import { describe, expect, it } from "vitest";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { lowerNativeStorage } from "../src/compiler/target/lower-native-storage.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import { emitCompiledFunction } from "../src/compiler/target/render-native-c.ts";

const SOURCE = `function retained(factory, collect) {
	const held = factory();
	collect();
	return held.marker;
}
globalThis.retained = retained;`;

function compile(): ProgramImage {
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(SOURCE, "/conservative-stack-roots.js"),
	);
}

function retainedIndex(image: ProgramImage): number {
	const index = image.runtime.functions.findIndex(
		(fn) =>
			String.fromCharCode(
				...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
			) === "retained",
	);
	expect(index).toBeGreaterThanOrEqual(0);
	return index;
}

function emit(image: ProgramImage, index: number): string {
	const source = emitCompiledFunction(
		image.native.functions[index]!,
		index,
		"",
		false,
	)?.source;
	if (source === undefined) throw new Error("retained has no native body");
	return source;
}

describe("native stack roots", () => {
	it("keeps values live across calls in C locals that the runtime scans", () => {
		const image = compile();
		const index = retainedIndex(image);
		const storage = image.native.functions[index]!.storage!;
		expect(storage.stackRoots).toBe("conservative");
		expect(storage.rootRegisters).toEqual([]);
		expect(storage.rootSlotCount).toBe(0);
		const source = emit(image, index);
		expect(source).not.toContain("root_frame_head");
		expect(source).not.toMatch(/MAL_ROOT_MASK(?:_ROW)?\(/);
	});

	it("serializes the stack-root mode with each storage plan", () => {
		const image = compile();
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const index = retainedIndex(image);
		expect(restored.native.functions[index]!.storage!.stackRoots).toBe("conservative");
		expect(emit(restored, index)).toBe(emit(image, index));
	});

	it("relowers to precise shadow-frame roots for targets that cannot scan stacks", () => {
		const image = lowerNativeStorage(compile(), "precise");
		const index = retainedIndex(image);
		const storage = image.native.functions[index]!.storage!;
		expect(storage.stackRoots).toBe("precise");
		expect(storage.rootRegisters.length).toBeGreaterThan(0);
		expect(emit(image, index)).toContain("vm->root_frame_head = &__gc_frame;");
		const restored = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		expect(restored.native.functions[index]!.storage!.stackRoots).toBe("precise");
	});
});
