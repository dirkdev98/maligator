import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { liftLocalCaptureArguments } from "../src/compiler/core/core-local-capture-arguments.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import {
	analysisProgram,
	programAnalysisContext,
} from "./helpers/core-program-analysis.ts";

const arithmetic = Array.from(
	{ length: 20 },
	(_, index) => `(x * ${index + 1} + bias)`,
).join(" + ");

function compile(body: string, closed = true, profile = false) {
	const entry = "/local-capture-arguments.js";
	const base = compilerProgramFactsFromConfig(
		resolveBuildConfig({
			engine: { eval: false, realms: false, primordials: "locked" },
		}),
	);
	return compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(body, entry),
		{
			facts: closed
				? withProgramClosure(
						base,
						programClosureCertificate({ kind: "whole-program", entry }, [], []),
					)
				: base,
			coreVerification: "per-pass",
			profile,
		},
	);
}

const localSource = `globalThis.run = function run(seed) {
	let bias = seed;
	const read = x => ${arithmetic};
	let sum = 0;
	for (let i = 0; i < 100; i++) { bias = (bias + 1) | 0; sum += read(i); }
	return sum;
};`;

function privateHelpers(image: ReturnType<typeof compile>) {
	return image.runtime.functions.flatMap((fn, index) =>
		fn.parameterCount === 2 && fn.length === 1
			? [{ fn, native: image.native.functions[index]! }]
			: [],
	);
}

// Model one physical store directly, so these tests exercise dominance rather
// than being rejected for a frontend-generated TDZ/undefined initializer.
function singleStoreAlias(mode: "after" | "before" | "branch" | "handler" | "mapped") {
	const program = analysisProgram();
	const creator = new CoreFunctionBuilder(program, {
		parameterCount: 1,
		metadata: {
			strict: true,
			capturedCount: 2,
			...(mode === "mapped" ? { mappedArguments: true, mappedArgumentSlots: [1] } : {}),
		},
	});
	const entry = creator.createBlock([{}]);
	const input = creator.blockParameterValue(entry, 0);
	const helper = new CoreFunctionBuilder(program, {
		parameterCount: 1,
		metadata: { strict: true, length: 1 },
	});
	const body = helper.createBlock([{}]);
	const slot = { functionIndex: creator.functionId, index: 0 };
	const [captured] = helper.appendInstruction(body, "loadCaptured", [], {
		attributes: slot,
	});
	helper.setTerminator(body, { kind: "return", value: captured! });
	helper.finish(body);
	const [callee] = creator.appendInstruction(entry, "createFunction", [], {
		attributes: { functionIndex: helper.functionId },
	});
	const [receiver] = creator.appendInstruction(entry, "createUndefined", []);
	creator.appendInstruction(entry, "storeCaptured", [input], { attributes: slot });
	const alias = { functionIndex: creator.functionId, index: 1 };
	let storeBlock = entry;
	let callBlock = entry;
	if (mode === "branch") {
		storeBlock = creator.createBlock();
		callBlock = creator.createBlock();
		creator.setTerminator(entry, {
			kind: "branch",
			condition: input,
			consequent: { block: storeBlock, arguments: [] },
			alternate: { block: callBlock, arguments: [] },
		});
		creator.setTerminator(storeBlock, {
			kind: "jump",
			edge: { block: callBlock, arguments: [] },
		});
	} else if (mode === "handler") {
		callBlock = creator.createBlock([{ role: "exception" }]);
		creator.setHandler(entry, callBlock);
		creator.appendInstruction(entry, "call", [input, receiver!]);
		creator.setTerminator(entry, { kind: "return", value: receiver! });
	}
	const write = () =>
		creator.appendInstruction(storeBlock, "storeCaptured", [callee!], {
			attributes: alias,
		});
	if (mode !== "before") write();
	const [loaded] = creator.appendInstruction(callBlock, "loadCaptured", [], {
		attributes: alias,
	});
	const [localReceiver] = creator.appendInstruction(callBlock, "createUndefined", []);
	const [result] = creator.appendInstruction(callBlock, "call", [
		loaded!,
		localReceiver!,
		input,
	]);
	if (mode === "before") write();
	creator.setTerminator(callBlock, { kind: "return", value: result! });
	creator.finish(entry);
	verifyCoreProgram(program);
	const lifted = liftLocalCaptureArguments({
		program,
		context: programAnalysisContext(),
	});
	verifyCoreProgram(program);
	return lifted;
}

describe("private local capture arguments", () => {
	it("follows a sole captured writer only after its store", () => {
		expect(singleStoreAlias("after")).toBe(1);
	});

	it.each(["before", "branch", "handler", "mapped"] as const)(
		"does not follow an unsafe sole captured writer: %s",
		(mode) => expect(singleStoreAlias(mode)).toBe(0),
	);

	it("connects the captured representation to typed arguments and results", () => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(compile(localSource)),
		);
		const helpers = privateHelpers(image);
		expect(helpers).toHaveLength(1);
		const { fn, native } = helpers[0]!;
		expect(
			fn.instructions.some((instruction) => instruction.opcode === "LOAD_CAPTURED"),
		).toBe(false);
		expect(native.directEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					parameterRepresentations: ["number", "number"],
					resultRepresentation: "number",
				}),
			]),
		);
	});

	it("retains source-site profiling and artifact round trips for a lifted helper", () => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(compile(localSource, true, true)),
		);
		expect(privateHelpers(image)).toHaveLength(1);
	});

	it.each([
		["branches", `if (x < 0) return bias - x; return ${arithmetic};`],
		[
			"loop-carried values",
			`let sum = 0; for (let i = 0; i < (x & 7); i++) sum += i + bias; return sum + ${arithmetic};`,
		],
		[
			"switch edges",
			`switch (x & 3) { case 0: return bias; case 1: return x - bias; default: return ${arithmetic}; }`,
		],
	])("connects captures through %s to numeric native entries", (_label, body) => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(
				compile(
					localSource.replace(
						`const read = x => ${arithmetic};`,
						`const read = x => { ${body} };`,
					),
					true,
					true,
				),
			),
		);
		const helpers = privateHelpers(image);
		expect(helpers).toHaveLength(1);
		expect(
			helpers[0]!.fn.instructions.some(
				(instruction) => instruction.opcode === "LOAD_CAPTURED",
			),
		).toBe(false);
		expect(helpers[0]!.native.directEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					parameterRepresentations: ["number", "number"],
					resultRepresentation: "number",
				}),
			]),
		);
	});

	it("keeps helpers with exception edges on their original capture convention", () => {
		const image = compile(
			localSource.replace(
				`const read = x => ${arithmetic};`,
				`const read = x => { try { globalThis.observe(x); return ${arithmetic}; } catch { return bias; } };`,
			),
		);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("keeps escaping closure objects on their original calling convention", () => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed; const read = x => ${arithmetic};
			globalThis.escaped = read; return read(4);
		};`);
		expect(privateHelpers(image)).toHaveLength(1);
		expect(
			image.runtime.functions.some(
				(fn) =>
					fn.parameterCount === 1 &&
					fn.length === 1 &&
					fn.instructions.some((op) => op.opcode === "LOAD_CAPTURED"),
			),
		).toBe(true);
	});

	it("uses typed entries for an escaped helper without specializing its generic entry", () => {
		const image = deserializeCompilerArtifact(
			serializeCompilerArtifact(
				compile(
					localSource.replace("let sum = 0;", "globalThis.escaped = read; let sum = 0;"),
					true,
					true,
				),
			),
		);
		const helpers = privateHelpers(image);
		expect(helpers).toHaveLength(1);
		expect(helpers[0]!.native.directEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					parameterRepresentations: ["number", "number"],
					resultRepresentation: "number",
				}),
			]),
		);
		expect(
			image.runtime.functions.some(
				(fn) =>
					fn.parameterCount === 1 &&
					fn.instructions.some((op) => op.opcode === "LOAD_CAPTURED"),
			),
		).toBe(true);
	});

	it.each([
		"globalThis.escaped = read;",
		"globalThis.length = read.length; globalThis.name = read.name;",
		"globalThis.extra = read(4, 9);",
		"globalThis.constructed = new read(4);",
		"globalThis.observe(read);",
	])("retains the original closure for %s alongside the private call", (observation) => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed; const read = function(x) { return ${arithmetic}; };
			${observation} return read(4);
		};`);
		expect(privateHelpers(image)).toHaveLength(1);
		expect(
			image.runtime.functions.some(
				(fn) =>
					fn.parameterCount === 1 &&
					fn.length === 1 &&
					fn.instructions.some((op) => op.opcode === "LOAD_CAPTURED"),
			),
		).toBe(true);
	});

	it("does not allocate a private target when all calls are dynamic", () => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed; const read = x => ${arithmetic};
			globalThis.escaped = read; return globalThis.invoke(read);
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("retains an escaping identity used by an exception handler", () => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed; const read = x => ${arithmetic};
			try { return read(4); } catch { return read; }
		};`);
		expect(privateHelpers(image)).toHaveLength(1);
	});

	it("connects hoisted declarations through their single-writer captured binding", () => {
		const image = compile(
			localSource.replace(
				`const read = x => ${arithmetic};`,
				`function read(x) { return ${arithmetic}; } globalThis.escaped = read;`,
			),
		);
		expect(privateHelpers(image)).toHaveLength(1);
		expect(privateHelpers(image)[0]!.native.directEntries).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					parameterRepresentations: ["number", "number"],
					resultRepresentation: "number",
				}),
			]),
		);
	});

	it("does not bypass a reassigned declaration binding", () => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed; function read(x) { return ${arithmetic}; }
			globalThis.current = () => read; read = x => x; return read(4);
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("does not hoist an uninitialized captured alias across a conditional assignment", () => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed; let read;
			globalThis.current = () => read;
			if (seed) read = x => ${arithmetic};
			return read(4);
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("does not bypass a handler that can skip binding initialization", () => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed; let read;
			globalThis.current = () => read;
			try { globalThis.mayThrow(); read = x => ${arithmetic}; }
			catch { return read(4); }
			return 0;
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("retains an unused TDZ read and its reachable exception handler", () => {
		const image = compile(`globalThis.run = function initializedLater() {
			const read = () => value; let early;
			try { read(); } catch (error) { early = error instanceof ReferenceError; }
			const value = { answer: 42 };
			globalThis.early = early; return read;
		};`);
		expect(
			image.runtime.functions.some((fn) =>
				fn.instructions.some((op) => op.opcode === "THROW_IF_TDZ"),
			),
		).toBe(true);
		expect(image.runtime.functions.some((fn) => fn.parameterCount !== fn.length)).toBe(
			false,
		);
	});

	it("specializes initialized calls without exposing the earlier TDZ sentinel as an argument", () => {
		const image = compile(`globalThis.run = function run() {
			const read = x => ${arithmetic}; let early;
			try { read(1); } catch (error) { early = error instanceof ReferenceError; }
			const bias = 9;
			globalThis.early = early;
			globalThis.escaped = read; return read(2);
		};`);
		expect(privateHelpers(image)).toHaveLength(1);
		expect(
			image.runtime.functions.some(
				(fn) =>
					fn.parameterCount === 1 &&
					fn.instructions.some((op) => op.opcode === "THROW_IF_TDZ"),
			),
		).toBe(true);
	});

	it("does not move TDZ checks before effects inside the original helper", () => {
		const image = compile(`globalThis.run = function run(input) {
			const read = x => +x + bias; let early;
			try { read(input); } catch (error) { early = error instanceof ReferenceError; }
			const bias = 9;
			globalThis.early = early;
			globalThis.escaped = read; return read(2);
		};`);
		expect(
			image.runtime.functions.some(
				(fn) =>
					fn.parameterCount === 1 &&
					fn.instructions.some((op) => op.opcode === "THROW_IF_TDZ"),
			),
		).toBe(true);
	});

	it("keeps a handler call generic when an exception may skip capture initialization", () => {
		const image = compile(`globalThis.run = function run(input) {
			const read = x => ${arithmetic}; globalThis.escaped = read;
			try { globalThis.mayThrow(); const unused = input; }
			catch { return read(2); }
			const bias = 9; return 0;
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("keeps sibling-writable bindings shared across reentrant calls", () => {
		const image = compile(`globalThis.run = seed => {
			let bias = seed; const read = x => ${arithmetic};
			globalThis.write = next => bias = next; return read(4);
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it.each([
		"arguments.length + x + bias",
		"arguments[x] + bias",
		"arguments[1] + x + bias",
	])("does not expose capture arguments through %s", (expression) => {
		const image = compile(`globalThis.run = seed => {
			const bias = seed;
			function read(x) { return ${expression}; }
			let sum = 0; for(let i = 0; i < 100; i++) sum += read(i); return sum;
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("does not lift per-iteration cell identities", () => {
		const image = compile(`globalThis.run = seed => {
			let sum = 0;
			for (let bias = 0; bias < 10; bias++) {
				const read = x => ${arithmetic}; sum += read(seed);
			}
			return sum;
		};`);
		expect(privateHelpers(image)).toHaveLength(0);
	});

	it("keeps the generic source-visible convention without a closure certificate", () => {
		expect(privateHelpers(compile(localSource, false))).toHaveLength(0);
	});
});
