import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CoreEditor } from "../src/compiler/core/core-editor.ts";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { coreInstructionEffects } from "../src/compiler/core/core-ir-opcodes.ts";
import { verifyCoreProgram } from "../src/compiler/core/core-ir-verifier.ts";
import { coreModulePrivateNames } from "../src/compiler/core/core-private-names.ts";
import { coreReadAccessorSummary } from "../src/compiler/core/core-read-accessors.ts";
import { optimizeCore } from "../src/compiler/core/optimize.ts";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	deserializeCompilerArtifact,
	serializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { coreFunctionNamed, coreOperations } from "./helpers/core-inspection.ts";

const source = `class Columns {
	#columns;
	constructor(columns) { this.#columns = columns; }
	read(index) { return this.#columns.items[index] ?? 0; }
}
function pair(receiver, index) {
	const first = receiver.read(index);
	const second = receiver.read(index);
	return [first, second];
}
globalThis.probe = pair;`;

function semantic(text = source) {
	return analyzeSourceAndRunSemanticAnalysis(
		text,
		"/read-accessors.mjs",
		parseModule(text),
	);
}

describe("class read-accessor lowering", () => {
	it("reports bounded region discovery work separately from expanded execution", () => {
		const input = lowerSemanticProgramToCore(semantic());
		const { report } = optimizeCore(input, { instrumentation: "counters" });
		expect(report.transforms.accessorRegionDiscoveries).toBeGreaterThan(0);
		expect(report.transforms.accessorRegionsApplied).toBeGreaterThan(0);
		expect(report.transforms.accessorInstructionVisits).toBeLessThanOrEqual(
			report.transforms.accessorRegionDiscoveries! * 52,
		);
	});

	it("can ablate expansion while retaining ordinary inlining and the same summaries", () => {
		const input = lowerSemanticProgramToCore(semantic());
		optimizeCore(input, {
			verification: "per-pass",
			benchmarkAblation: { family: "class-read-accessors" },
		});
		const accessor = coreFunctionNamed(input.program, "read")!;
		expect(
			coreReadAccessorSummary(accessor, buildCoreControlFlow(input.program, accessor.id))
				?.reads,
		).toHaveLength(3);
		expect(
			coreOperations(coreFunctionNamed(input.program, "pair")!).some(
				({ opcode }) => opcode === "probeRead",
			),
		).toBe(false);
	});

	it("preserves dominance when earlier candidates change a planned caller in the same batch", () => {
		const input = lowerSemanticProgramToCore(
			semantic(readFileSync("tests/local/read-accessor-regions.mjs", "utf8")),
		);
		optimizeCore(input, { verification: "per-pass" });
		verifyCoreProgram(input.program, undefined, input.context);
	});

	it.each(["this.#value", "this.value"])(
		"retains ordinary inlining when %s has no shared read chain",
		(read) => {
			const input = lowerSemanticProgramToCore(
				semantic(`class Scalar {
					#value = 7; value = 7;
					read() { return ${read}; }
				}
				function scan(receiver) {
					let result = 0;
					for (let index = 0; index < 10; index++) result += receiver.read();
					return result;
				}
				globalThis.scan = scan;`),
			);
			optimizeCore(input, { verification: "per-pass" });
			const operations = coreOperations(coreFunctionNamed(input.program, "scan")!);
			expect(operations.some(({ opcode }) => opcode === "probeRead")).toBe(false);
			expect(
				operations.some(
					({ opcode, attributes }) =>
						opcode === "call" && attributes.guardedInlineFallback === true,
				),
			).toBe(true);
			expect(
				operations.some(({ opcode }) =>
					read === "this.#value"
						? opcode === "loadPrivate"
						: opcode === "loadPropertyStatic",
				),
			).toBe(true);
		},
	);

	it("bounds rejected-summary discovery in a large straight-line method", () => {
		const calls = Array.from(
			{ length: 80 },
			(_, index) => `globalThis.touch(${index});`,
		).join("\n");
		const input = lowerSemanticProgramToCore(
			semantic(
				source.replace(
					"return this.#columns.items[index] ?? 0;",
					`${calls}\nreturn this.#columns.items[index] ?? 0;`,
				),
			),
		);
		const fn = coreFunctionNamed(input.program, "read")!;
		const cfg = buildCoreControlFlow(input.program, fn.id);
		const original = Object.getOwnPropertyDescriptor(fn, "bodyInstructionIds");
		const instructions = fn.bodyInstructionIds.bind(fn);
		let visited = 0;
		fn.bodyInstructionIds = function* (block) {
			for (const instruction of instructions(block)) {
				visited++;
				yield instruction;
			}
		};
		try {
			expect(coreReadAccessorSummary(fn, cfg)).toBeUndefined();
			expect(visited).toBeGreaterThan(0);
			expect(visited).toBeLessThanOrEqual(25);
		} finally {
			if (original === undefined) Reflect.deleteProperty(fn, "bodyInstructionIds");
			else Object.defineProperty(fn, "bodyInstructionIds", original);
		}
	});

	it("rejects an inverted nullish branch", () => {
		const input = lowerSemanticProgramToCore(
			semantic(
				source.replace(
					"return this.#columns.items[index] ?? 0;",
					"const value = this.#columns.items[index]; return value == undefined ? value : 0;",
				),
			),
		);
		optimizeCore(input);
		const fn = coreFunctionNamed(input.program, "read")!;
		expect(
			coreReadAccessorSummary(fn, buildCoreControlFlow(input.program, fn.id)),
		).toBeUndefined();
	});
	it("describes the read chain and its nullish default without declaring it pure", () => {
		const input = lowerSemanticProgramToCore(semantic());
		optimizeCore(input);
		const fn = coreFunctionNamed(input.program, "read")!;
		const summary = coreReadAccessorSummary(
			fn,
			buildCoreControlFlow(input.program, fn.id),
		);
		expect(summary?.reads.map((read) => read.kind)).toEqual([
			"private",
			"named",
			"indexed",
		]);
		expect(summary?.defaultValue).toEqual({ kind: "number", value: 0 });
		expect(
			[...fn.instructionIds()].some(
				(instruction) =>
					fn.instructionKind(instruction) === "operation" &&
					fn.instructionOpcodeName(instruction) === "loadProperty" &&
					coreInstructionEffects(fn, instruction).callsUserCode,
			),
		).toBe(true);
	});

	it("shares admitted backing, named-array, and element reads while retaining original calls as fallback", () => {
		const input = lowerSemanticProgramToCore(semantic());
		optimizeCore(input, { verification: "per-pass" });
		const fn = coreFunctionNamed(input.program, "pair")!;
		const operations = coreOperations(fn);
		expect(
			operations
				.filter(({ opcode }) => opcode === "call")
				.every(({ attributes }) => attributes.guardedInlineFallback === true),
		).toBe(true);
		expect(
			operations.filter(
				({ opcode, attributes }) =>
					opcode === "probeRead" && attributes.readKind === "private",
			),
		).toHaveLength(1);
		expect(
			operations.filter(
				({ opcode, attributes }) =>
					opcode === "probeRead" && attributes.readKind === "indexed",
			),
		).toHaveLength(1);
		expect(
			operations.filter(
				({ opcode, attributes }) =>
					opcode === "probeRead" && attributes.readKind === "named",
			),
		).toHaveLength(2);
	});

	it("rejects a forged second private-name writer and refreshes after edits", () => {
		const input = lowerSemanticProgramToCore(semantic());
		const names = coreModulePrivateNames(input.program, input.context);
		const record = input.context.data.modulePrivateNames![0]!;
		expect(names.validSlot(record.slot)).toBe(true);
		const fn = input.program.function(record.evaluator as never);
		const editor = CoreEditor.open(input.program, fn.id);
		const minted = editor.insertInstruction(
			fn.entry,
			fn.blockTerminator(fn.entry),
			"createPrivateName",
			[],
		);
		editor.insertInstruction(
			fn.entry,
			fn.blockTerminator(fn.entry),
			"storeGlobal",
			minted.outputs,
			{ outputCount: 0, attributes: { index: record.slot } },
		);
		editor.commit();
		expect(names.validSlot(record.slot)).toBe(false);
		expect(() => verifyCoreProgram(input.program, undefined, input.context)).toThrow(
			"unique acyclic private-name initializer",
		);
	});

	it("keeps factory and loop class evaluations outside the module-private contract", () => {
		const input = lowerSemanticProgramToCore(
			semantic(`function make() { return class { #value = 1; read() { return this.#value; } }; }
		for (let index = 0; index < 2; index++) { class Loop { #value = index; read() { return this.#value; } } globalThis.loop = Loop; }
		globalThis.make = make;`),
		);
		expect(input.context.data.modulePrivateNames).toEqual([]);
	});

	it("round-trips admitted operations through the compiler artifact", () => {
		const image = compileSemanticProgramToProgramImage(semantic());
		const decoded = deserializeCompilerArtifact(serializeCompilerArtifact(image));
		const probes = (program: typeof image) =>
			program.runtime.functions.flatMap((fn) =>
				fn.instructions.filter((instruction) => instruction.opcode === "PROBE_READ"),
			);
		expect(probes(image).length).toBeGreaterThan(0);
		expect(probes(decoded)).toEqual(probes(image));
	});

	it.each(["materializeInstructionOperands", "materializeInstructionResults"])(
		"lowers the real kernel loop in %s",
		(name) => {
			const kernel = readFileSync("src/compiler/core/core-function-kernel.ts", "utf8");
			const callers = readFileSync(
				"src/compiler/core/core-cross-call-transforms.ts",
				"utf8",
			);
			const start = callers.indexOf(`function ${name}(`);
			const end = callers.indexOf("\nfunction ", start + 1);
			const text = stripCompactTypes(
				`${kernel}\n${callers.slice(start, end)}\nglobalThis.probe = ${name};`,
			);
			const input = lowerSemanticProgramToCore(semantic(text));
			optimizeCore(input, { verification: "per-pass" });
			const fn = coreFunctionNamed(input.program, name)!;
			const operations = coreOperations(fn);
			expect(
				operations.filter(
					({ opcode, attributes }) =>
						opcode === "probeRead" && attributes.readKind === "private",
				),
			).toHaveLength(2);
			expect(
				operations.filter(({ opcode }) => opcode === "guardFunctionIndex"),
			).toHaveLength(3);
			const cfg = buildCoreControlFlow(input.program, fn.id);
			expect(cfg.loops.length).toBeGreaterThan(0);
		},
	);
});
