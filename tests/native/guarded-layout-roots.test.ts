import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { resolveBuildConfig } from "../../src/build-config.ts";
import { lowerNativeStorage } from "../../src/compiler/target/lower-native-storage.ts";
import type { BytecodeInstruction } from "../../src/compiler/target/runtime-image.ts";
import {
	buildBackendPairFromOneProgramImage,
	buildNativeProgramImage,
	HOST_MAIN,
	runToStdout,
	STRESS_ENV,
} from "../../src/test-harness.ts";

it("retains private receivers and results through guarded layout hits, GC in getters, setters, proxies and throws", () => {
	const fixture = "tests/local/guarded-layout-roots.mjs";
	const directory = mkdtempSync(join(tmpdir(), "mal-layout-roots-"));
	try {
		const expected = execFileSync(process.execPath, ["--expose-gc", fixture], {
			encoding: "utf8",
		});
		const options = {
			fixture,
			name: "guarded-layout-roots",
			outDir: directory,
			mainFile: HOST_MAIN,
			nativeStackRoots: "precise" as const,
			config: resolveBuildConfig({ engine: { primordials: "mutable" } }),
		};
		const { programImage, interpreted } = buildBackendPairFromOneProgramImage(options);
		const text = (index: number) =>
			String.fromCharCode(...(programImage.runtime.stringConstants[index] ?? []));
		const own = programImage.native.functions.find(
			(fn) => text(fn.body.nameStringIndex) === "own",
		)!;
		const shape = own.body.instructions.find(
			(op) =>
				op.opcode === "CREATE_OBJECT_SHAPED" &&
				op.keyStringIndices.some((index) => text(index) === "x"),
		);
		if (shape?.opcode !== "CREATE_OBJECT_SHAPED")
			throw new Error("Missing own-slot shape");
		const candidates = [
			{
				shapeFunctionIndex: own.functionIndex,
				shapeCacheIndex: shape.shapeCacheIndex,
				slot: shape.keyStringIndices.findIndex((index) => text(index) === "x"),
			},
		];
		const precompiledLiteralShapes = [...programImage.runtime.precompiledLiteralShapes];
		if (
			!precompiledLiteralShapes.some(
				(entry) =>
					entry.functionIndex === own.functionIndex &&
					entry.shapeCacheIndex === shape.shapeCacheIndex,
			)
		)
			precompiledLiteralShapes.push({
				functionIndex: own.functionIndex,
				shapeCacheIndex: shape.shapeCacheIndex,
				keyStringIndices: shape.keyStringIndices,
			});
		let changed = 0;
		const functions = programImage.native.functions.map((fn) => {
			const name = text(fn.body.nameStringIndex);
			if (!name.startsWith("slot")) return fn;
			return {
				...fn,
				body: {
					...fn.body,
					instructions: fn.body.instructions.map((op): BytecodeInstruction => {
						if (
							op.opcode === "LOAD_PROPERTY_STATIC" &&
							text(op.stringIndex) === (name === "slotLength" ? "length" : "x")
						) {
							changed++;
							return name === "slotLength"
								? { ...op, opcode: "LOAD_PROPERTY_STATIC_ARRAY_LENGTH" }
								: { ...op, opcode: "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT", candidates };
						}
						if (op.opcode === "STORE_PROPERTY_STATIC" && text(op.stringIndex) === "x") {
							changed++;
							return {
								...op,
								opcode: "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT",
								candidates,
							};
						}
						return op;
					}),
				},
			};
		});
		expect(changed).toBe(5);
		const image = lowerNativeStorage(
			{
				...programImage,
				runtime: {
					...programImage.runtime,
					precompiledLiteralShapes,
					// VM and native bodies share cache identities but allocate registers independently.
					functions: programImage.runtime.functions.map((fn, index) => ({
						...fn,
						instructions: fn.instructions.map((op): BytecodeInstruction => {
							if (
								op.opcode !== "LOAD_PROPERTY_STATIC" &&
								op.opcode !== "STORE_PROPERTY_STATIC"
							)
								return op;
							const target = functions[index]!.body.instructions.find(
								(candidate) => "icIndex" in candidate && candidate.icIndex === op.icIndex,
							);
							if (
								op.opcode === "LOAD_PROPERTY_STATIC" &&
								target?.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT"
							)
								return { ...op, opcode: target.opcode, candidates };
							if (
								op.opcode === "STORE_PROPERTY_STATIC" &&
								target?.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT"
							)
								return { ...op, opcode: target.opcode, candidates };
							if (
								op.opcode === "LOAD_PROPERTY_STATIC" &&
								target?.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH"
							)
								return { ...op, opcode: target.opcode };
							return op;
						}),
					})),
				},
				native: { ...programImage.native, functions },
			},
			"precise",
		);
		for (const fn of image.native.functions) {
			if (!text(fn.body.nameStringIndex).startsWith("slot")) continue;
			const held = fn.body.instructions.find(
				(op) => op.opcode === "LOAD_PROPERTY_STATIC" && text(op.stringIndex) === "value",
			);
			if (held?.opcode !== "LOAD_PROPERTY_STATIC")
				throw new Error("Missing private receiver");
			expect(fn.storage!.privateRegisters).toContain(held.dst);
		}
		const compiled = buildNativeProgramImage(image, {
			...options,
			name: "guarded-layout-roots-specialized",
		});
		for (const binary of [compiled, interpreted])
			for (const stress of [{}, STRESS_ENV])
				expect(runToStdout(binary, { env: { MAL_HOST_GC: "1", ...stress } })).toBe(
					expected,
				);
	} finally {
		rmSync(directory, { recursive: true, force: true });
	}
}, 300_000);
