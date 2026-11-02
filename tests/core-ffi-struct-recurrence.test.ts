import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { validateNativeStackObject } from "../src/compiler/target/native-stack-object.ts";
import type { ProgramImage } from "../src/compiler/target/program-image.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

function compile(body: string): ProgramImage {
	const buildConfig = {
		...resolveBuildConfig({ engine: { eval: false, realms: false } }),
		ffiModules: [
			{
				id: "maligator:ffi/point",
				exports: ["add"],
				installer: "mal_ffi_install_point",
				direct: {
					add: {
						symbol: "mal_ffi_direct5_point_add",
						arity: 2,
						callsUserCode: true,
						borrows: [
							{ argument: 0, fields: ["x", "y"] },
							{ argument: 1, fields: ["x", "y"] },
						],
						into: { fields: ["x", "y"] },
					},
				},
			},
		],
	};
	return compileEntrypoint("/ffi-struct-recurrence.mjs", {
		buildConfig,
		entrySource: `import { add } from "maligator:ffi/point";
		function advance(input, count, rounds) { ${body} }
		globalThis.advance = advance;`,
	});
}

function advanceFunction(image: ProgramImage) {
	const fn = image.native.functions.find(
		(entry) =>
			entry.body.nameStringIndex >= 0 &&
			String.fromCharCode(
				...image.runtime.stringConstants[entry.body.nameStringIndex]!,
			) === "advance",
	)!;
	return fn;
}

function recurringSites(image: ProgramImage) {
	const fn = advanceFunction(image);
	return fn.specializations.flatMap((region) =>
		region.kind === "stack-object-plan"
			? region.sites.filter(
					(site) =>
						fn.body.instructions[site.allocationIp]?.opcode === "CALL" &&
						site.materializations.some(
							(entry) => entry.kind === "lend" && entry.ip === site.allocationIp,
						),
				)
			: [],
	);
}

describe("consumed foreign struct results", () => {
	it.each([false, true])(
		"admits a saved alias after reuse only when that alias was observed (observed: %s)",
		(observeAlias) => {
			const observed = observeAlias ? [0, 1] : [0];
			const instructions: Array<BytecodeInstruction> = [
				{
					opcode: "CALL",
					dst: 0,
					callee: 4,
					thisValue: 5,
					argumentCount: 1,
					arguments: [0],
				},
				{ opcode: "JUMP_IF", cond: 6, targetIp: 5 },
				{ opcode: "MOVE", src: 0, dst: 1 },
				{
					opcode: "CALL",
					dst: 6,
					callee: 7,
					thisValue: 5,
					argumentCount: observed.length,
					arguments: observed,
				},
				{ opcode: "JUMP", targetIp: 0 },
				{ opcode: "LOAD_PROPERTY_STATIC", dst: 3, object: 1, stringIndex: 0, icIndex: 0 },
				{ opcode: "RETURN", value: 3 },
			];
			const validate = () =>
				validateNativeStackObject(instructions, {
					allocationIp: 0,
					mode: "activation-local",
					slotCount: 1,
					keys: [0],
					accesses: [],
					materializations: [
						{ ip: 0, kind: "lend", values: [0] },
						{ ip: 3, kind: "observe", values: observed },
					],
				});
			if (observeAlias) expect(validate).not.toThrow();
			else expect(validate).toThrow("Invalid stack-object observation region");
		},
	);
	it("admits observed prior results in recurring storage certificates", () => {
		const image = compile(`
			let position = input; const velocity = { x: 1, y: 0.5 };
			for (let index = 0; index < count; index++) {
				rounds(position);
				position = add(position, velocity);
			}
			return position.x + position.y;
		`);
		expect(
			recurringSites(image).some((site) =>
				site.materializations.some((entry) => entry.kind === "observe"),
			),
		).toBe(true);
		expect(
			recurringSites(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
		).toEqual(recurringSites(image));
	});
	it("reuses storage when only some iterations observe a prior result", () => {
		const image = compile(`
			let position = input; const velocity = { x: 1, y: 0.5 };
			for (let index = 0; index < count; index++) {
				if (index % 16 === 0) rounds(position);
				position = add(position, velocity);
			}
			return position.x + position.y;
		`);
		expect(
			recurringSites(image).some((site) =>
				site.materializations.some((entry) => entry.kind === "observe"),
			),
		).toBe(true);
	});
	it("rejects observing the prior result at its replacement instruction", () => {
		const image = compile(`
			let position = input; const velocity = { x: 1, y: 0.5 };
			for (let index = 0; index < count; index++) position = add(position, velocity);
			return position.x;
		`);
		const fn = advanceFunction(image);
		const site = recurringSites(image)[0]!;
		const lend = site.materializations.find(
			(entry) => entry.kind === "lend" && entry.ip === site.allocationIp,
		)!;
		expect(() =>
			validateNativeStackObject(
				fn.body.instructions,
				{
					...site,
					materializations: [...site.materializations, { ...lend, kind: "observe" }],
				},
				fn.body.handlers,
			),
		).toThrow("Invalid stack-object observation region");
	});
	it("keeps a consumed result in stack storage across its loop backedge", () => {
		const image = compile(`
			let position = input; const velocity = { x: 1, y: 0.5 };
			for (let index = 0; index < count; index++) position = add(position, velocity);
			return position.x + position.y;
		`);
		expect(recurringSites(image).length).toBeGreaterThan(0);
		expect(
			recurringSites(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
		).toEqual(recurringSites(image));
	});

	it("prefers the repeated result over the seed literal's overlapping observer", () => {
		const image = compile(`
			let sum = 0;
			for (let round = 0; round < rounds; round++) {
				let position = { x: 0, y: 0 }; const velocity = { x: 1, y: 0.5 };
				for (let index = 0; index < count; index++) position = add(position, velocity);
				sum += position.x + position.y;
			}
			return sum;
		`);
		expect(recurringSites(image).length).toBeGreaterThan(0);
	});

	it("materializes a returned result while preserving the zero-iteration input path", () => {
		const image = compile(`
			let position = input; const velocity = { x: 1, y: 0.5 };
			for (let index = 0; index < count; index++) position = add(position, velocity);
			return position;
		`);
		expect(
			recurringSites(image).some((site) =>
				site.materializations.some((entry) => entry.kind === "return"),
			),
		).toBe(true);
		expect(
			recurringSites(deserializeCompilerArtifact(serializeCompilerArtifact(image))),
		).toEqual(recurringSites(image));
	});

	it.each([
		[
			"a saved previous object",
			`
			let position = input; const velocity = { x: 1, y: 0.5 }; let sum = 0;
			for (let index = 0; index < count; index++) {
				const previous = position; position = add(position, velocity); sum += previous.x;
			}
			return sum + position.x;
		`,
		],
		[
			"a handled conversion failure",
			`
			let position = input; const velocity = { x: 1, y: 0.5 };
			for (let index = 0; index < count; index++) {
				try { position = add(position, velocity); } catch { return position; }
			}
			return position;
		`,
		],
		[
			"a conditional producer",
			`
			let position = input; const velocity = { x: 1, y: 0.5 };
			for (let index = 0; index < count; index++) {
				if (index % 2) position = add(position, velocity);
			}
			return position.x;
		`,
		],
	])("keeps heap storage when the recurrence retains %s", (_name, body) => {
		expect(recurringSites(compile(body))).toEqual([]);
	});
});
