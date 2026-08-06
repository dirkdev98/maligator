import { describe, expect, it } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { compileSourceToBuffer } from "../src/compile.ts";
import { emitVmDefinition } from "../src/emit-vm.ts";
import { debugStackAlloc } from "../src/escape.ts";
import { debugInlinableCalls } from "../src/inline.ts";
import { annotateStackObjectSites, executeIROptimizations } from "../src/ir-opt.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import type { IntermediateProgram, IRInstruction } from "../src/ir.ts";
import { lowerIrProgramToVmDefinition } from "../src/lower-vm.ts";
import { parseScript } from "../src/parser.ts";
import { allocateRegisters } from "../src/register-alloc.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";
import { deserializeVmDefinition } from "../src/serialize-vm.ts";

function semantic(source: string) {
	return analyzeSourceAndRunSemanticAnalysis(
		source,
		"stack-object-test.js",
		parseScript(source, { strict: false }),
	);
}

function optimized(source: string): IntermediateProgram {
	const program = compileSemanticProgramToIr(semantic(source));
	executeIROptimizations(program);
	return program;
}

function instructions(program: IntermediateProgram): Array<IRInstruction> {
	return program.functions.flatMap((fn) =>
		fn.blocks.flatMap((block) => block.instructions),
	);
}

function stackSiteCount(program: IntermediateProgram): number {
	return instructions(program).filter(
		(instruction) =>
			(instruction.type === "createObject" ||
				instruction.type === "createObjectShaped") &&
			instruction.stackObject,
	).length;
}

function objectAllocationCount(program: IntermediateProgram): number {
	return instructions(program).filter(
		(instruction) =>
			instruction.type === "createObject" || instruction.type === "createObjectShaped",
	).length;
}

describe("scalar-replaced object observations", () => {
	it.each([
		[
			"standalone typeof",
			`function f() { const o = {}; return typeof o; } globalThis.keep = f;`,
			0,
		],
		[
			"same-site aliases",
			`function f(value) { const o = { x: value }; const alias = o; return typeof alias === "object" && o === alias && o !== alias === false ? alias.x : 0; } globalThis.keep = f;`,
			0,
		],
		[
			"distinct fresh sites",
			`function f(value) { const left = { x: value }; const right = { x: value + 1 }; return left !== right && left === right === false ? left.x + right.x : 0; } globalThis.keep = f;`,
			0,
		],
		[
			"per-iteration same-site identity",
			`function f(n) { let total = 0; for (let i = 0; i < n; i++) { const o = { x: i }; const alias = o; if (typeof o === "object" && o === alias) total += alias.x; } return total; } globalThis.keep = f;`,
			0,
		],
	])("eliminates %s", (_name, source, expected) => {
		expect(objectAllocationCount(optimized(source))).toBe(expected);
	});

	it.each([
		[
			"ambiguous branch merge",
			`function f(c) { const left = { x: 1 }; const right = { x: 2 }; let value = left; if (c) value = right; return value === left ? value.x : 0; } globalThis.keep = f;`,
			2,
		],
		[
			"loop-carried reassignment",
			`function f(n) { const first = { x: 1 }; let value = first; while (n-- > 0) value = { x: n }; return value === first ? value.x : 0; } globalThis.keep = f;`,
			2,
		],
		[
			"escaping comparison peer",
			`function f() { const left = { x: 1 }; const right = { x: 2 }; globalThis.saved = right; return left !== right ? left.x : 0; } globalThis.keep = f;`,
			2,
		],
		[
			"inherited read",
			`function f() { const o = { x: 1 }; return typeof o === "object" && typeof o.toString === "function" ? o.x : 0; } globalThis.keep = f;`,
			1,
		],
	])("rejects %s", (_name, source, expected) => {
		expect(objectAllocationCount(optimized(source))).toBe(expected);
	});
});

describe("closed fixed-shape stack-object proof", () => {
	it.each([
		[
			"empty identity-observed object",
			`function f(a, escape) { const o = {}; if (escape) return o; return typeof o === "object" && o === o ? a : 0; } globalThis.keep = f;`,
		],
		[
			"typeof with static own load",
			`function f(a, escape) { const o = { x: a }; if (escape) return o; return typeof o === "object" ? o.x : 0; } globalThis.keep = f;`,
		],
		[
			"strict identity and existing own store",
			`function f(a, escape) { const o = { x: a }; o.x = a + 1; if (escape) return o; return o === o ? o.x : 0; } globalThis.keep = f;`,
		],
		[
			"single-definition move alias",
			`function f(a, escape) { const o = { x: a }; const alias = o; if (escape) return alias; return typeof alias === "object" ? alias.x : 0; } globalThis.keep = f;`,
		],
	])("accepts %s", (_name, source) => {
		expect(stackSiteCount(optimized(source))).toBe(1);
	});

	it("rejects every property read from an empty stack-object candidate", () => {
		expect(
			stackSiteCount(
				optimized(
					`function f() { const o = {}; return typeof o === "object" ? o.missing : 0; } globalThis.keep = f;`,
				),
			),
		).toBe(0);
	});

	it("accepts loadPrototype as a non-retaining identity observation", () => {
		const program = optimized(
			`function f(escape) { const o = { x: 1 }; if (escape) return o; return typeof o; } globalThis.keep = f;`,
		);
		const unary = instructions(program).find(
			(instruction): instruction is Extract<IRInstruction, { type: "unary" }> =>
				instruction.type === "unary" && instruction.operator === "typeof",
		)!;
		const replacement: Extract<IRInstruction, { type: "loadPrototype" }> = {
			type: "loadPrototype",
			registers: [unary.registers[0], unary.registers[1]],
		};
		for (const fn of program.functions) {
			for (const block of fn.blocks) {
				const index = block.instructions.indexOf(unary);
				if (index >= 0) block.instructions[index] = replacement;
			}
		}
		annotateStackObjectSites(program);
		expect(stackSiteCount(program)).toBe(1);
		allocateRegisters(program);
		const source = emitVmDefinition(lowerIrProgramToVmDefinition(program), {
			compiled: true,
		});
		expect(source).toContain("MalObject __stack_object_");
		expect(source).toContain("mal_vm_op_load_prototype");
	});

	it.each([
		["return", `function f() { const o = { x: 1 }; return o; } globalThis.keep = f;`],
		[
			"global store",
			`function f() { const o = { x: 1 }; globalThis.saved = o; return 0; } globalThis.keep = f;`,
		],
		[
			"capture",
			`function f() { const o = { x: 1 }; return function () { return o.x; }; } globalThis.keep = f;`,
		],
		[
			"call argument",
			`function f() { const o = { x: 1 }; return g(o); } globalThis.keep = f;`,
		],
		[
			"call receiver",
			`function f(g) { const o = { m: g }; return o.m(); } globalThis.keep = f;`,
		],
		[
			"call callee",
			`function f() { const o = { x: 1 }; return o(); } globalThis.keep = f;`,
		],
		[
			"dynamic read",
			`function f(k) { const o = { x: 1 }; return typeof o === "object" ? o[k] : 0; } globalThis.keep = f;`,
		],
		[
			"missing-key read",
			`function f() { const o = { x: 1 }; return typeof o === "object" ? o.missing : 0; } globalThis.keep = f;`,
		],
		[
			"new-key store",
			`function f() { const o = { x: 1 }; o.y = 2; return typeof o; } globalThis.keep = f;`,
		],
		[
			"object used as stored value",
			`function f() { const o = { x: 1 }; o.x = o; return typeof o; } globalThis.keep = f;`,
		],
		[
			"delete",
			`function f() { const o = { x: 1 }; delete o.x; return typeof o; } globalThis.keep = f;`,
		],
		[
			"define property",
			`function f() { const o = { x: 1 }; Object.defineProperty(o, "x", { value: 2 }); return typeof o; } globalThis.keep = f;`,
		],
		[
			"set prototype",
			`function f() { const o = { x: 1 }; Object.setPrototypeOf(o, null); return typeof o; } globalThis.keep = f;`,
		],
		[
			"heap store",
			`function f(holder) { const o = { x: 1 }; holder.value = o; return 0; } globalThis.keep = f;`,
		],
		["throw", `function f() { const o = { x: 1 }; throw o; } globalThis.keep = f;`],
		[
			"enumeration",
			`function f() { const o = { x: 1 }; for (const key in o) return key; return typeof o; } globalThis.keep = f;`,
		],
		[
			"generator",
			`function* f() { const o = { x: 1 }; yield typeof o; } globalThis.keep = f;`,
		],
		[
			"async",
			`async function f() { const o = { x: 1 }; return typeof o; } globalThis.keep = f;`,
		],
		[
			"direct eval",
			`function f() { const o = { x: 1 }; eval("0"); return typeof o; } globalThis.keep = f;`,
		],
		[
			"with dynamic scope",
			`function f(scope) { const o = { x: 1 }; with (scope) { x; } return typeof o; } globalThis.keep = f;`,
		],
	])("rejects %s", (_name, source) => {
		expect(stackSiteCount(optimized(source))).toBe(0);
	});

	it("bounds aggregate rooted stack-object slots per function", () => {
		const sites = Array.from(
			{ length: 257 },
			(_, index) =>
				`const o${index} = { x: ${index} }; if (escape === ${index}) return o${index}; total += typeof o${index} === "object" ? o${index}.x : 0;`,
		).join("\n");
		const program = optimized(
			`function f(escape) { let total = 0; ${sites} return total; } globalThis.keep = f;`,
		);
		expect(stackSiteCount(program)).toBe(256);
	});

	it("accepts direct alias returns when a dominated nonescaping return remains", () => {
		const program = optimized(
			`function f(escape, value) { const o = { x: value }; const alias = o; alias.x = value + 1; if (escape) return alias; return typeof o === "object" && o === alias ? o.x : 0; } globalThis.keep = f;`,
		);
		expect(stackSiteCount(program)).toBe(1);
		const returns = instructions(program).filter(
			(instruction): instruction is Extract<IRInstruction, { type: "return" }> =>
				instruction.type === "return",
		);
		expect(
			returns.filter(
				(instruction) => instruction.stackObjectMaterializeSiteId !== undefined,
			),
		).toHaveLength(1);
		expect(
			returns.filter(
				(instruction) => instruction.stackObjectMaterializeSiteId === undefined,
			),
		).not.toHaveLength(0);
	});

	it("accepts an empty createObject with a conditional return", () => {
		expect(
			stackSiteCount(
				optimized(
					`function f(escape) { const o = {}; if (escape) return o; return typeof o === "object" && o === o ? 1 : 0; } globalThis.keep = f;`,
				),
			),
		).toBe(1);
	});

	it("preserves partial escape when a helper is called from a loop", () => {
		const program = optimized(`
			function run(count) {
				function partial(value, escape) {
					const object = { value };
					if (escape) return object;
					return typeof object === "object" ? object.value : 0;
				}
				let total = 0;
				for (let i = 0; i < count; i++) {
					const result = partial(i, i === count - 1);
					total += typeof result === "object" ? result.value : result;
				}
				return total;
			}
			globalThis.keep = run;
		`);
		expect(stackSiteCount(program)).toBe(1);
		expect(
			instructions(program).filter((instruction) => instruction.type === "call"),
		).toHaveLength(1);
		expect(
			instructions(program).filter(
				(instruction) =>
					instruction.type === "return" &&
					instruction.stackObjectMaterializeSiteId !== undefined,
			),
		).toHaveLength(1);
		expect(debugInlinableCalls(program)).toContain("kept call: partial escape in cycle");
		const stackAlloc = debugStackAlloc(program);
		expect(stackAlloc).toContain("native-stack slots=1 materializing-returns=1");
		expect(stackAlloc).toContain("1 native-stack");
	});

	it.each([
		[
			"looped activation",
			`function f(escape, n) { const o = { x: n }; while (n-- > 0) o.x = n; if (escape) return o; return typeof o === "object" ? o.x : 0; } globalThis.keep = f;`,
		],
		[
			"exception region",
			`function f(escape) { const o = { x: 1 }; try { if (escape) return o; } catch (error) {} return typeof o === "object" ? o.x : 0; } globalThis.keep = f;`,
		],
		[
			"continuing global escape",
			`function f(escape) { const o = { x: 1 }; if (escape) return o; globalThis.saved = o; return 0; } globalThis.keep = f;`,
		],
	])("keeps the partial-return subset closed for %s", (_name, source) => {
		expect(stackSiteCount(optimized(source))).toBe(0);
	});
});

describe("stack-object native metadata and C emission", () => {
	it("emits an immortal stack MalObject backed by activation root slots", () => {
		const definition = compileSemanticProgramToVmDefinition(
			semantic(
				`function f(escape) { const o = { x: "heap:" + 1 }; if (escape) return o; return typeof o === "object" && o === o ? o.x : ""; } globalThis.keep = f;`,
			),
		);
		const fn = definition.functions.find(
			(candidate) => (candidate.stackObjectAccesses?.length ?? 0) > 0,
		)!;
		expect(fn.stackObjectAccesses).toHaveLength(1);
		const access = fn.stackObjectAccesses![0]!;
		expect(fn.instructions[access.instructionIndex]?.opcode).toBe("LOAD_PROPERTY_STATIC");
		const source = emitVmDefinition(definition, { compiled: true });
		expect(source).toContain("MalObject __stack_object_");
		expect(source).toContain("MAL_HEAP_HEADER_IMMORTAL(MAL_HEAP_OBJECT)");
		expect(source).toMatch(/\.slots = &__gc_slots\[\d+\]/);
		expect(source).toContain("mal_value_from_object(&__stack_object_");
		expect(source).toMatch(/r\d+ = __gc_slots\[\d+\];/);
		expect(source).not.toContain("= mal_vm_create_object_shaped(vm");
	});

	it("emits an empty stack MalObject without activation slots", () => {
		const definition = compileSemanticProgramToVmDefinition(
			semantic(
				`function f(a, escape) { const o = {}; if (escape) return o; return typeof o === "object" && o === o ? a : 0; } globalThis.keep = f;`,
			),
		);
		const source = emitVmDefinition(definition, { compiled: true });
		expect(source).toContain("MalObject __stack_object_");
		expect(source).toContain(".shape = mal_shape_root(&vm->heap)");
		expect(source).toContain(".slots = nullptr");
		expect(source).not.toContain("mal_vm_op_create_object(vm)");
	});

	it("keeps a rejected site on the heap allocation path", () => {
		const definition = compileSemanticProgramToVmDefinition(
			semantic(
				`function f() { const o = { x: 1 }; globalThis.saved = o; } globalThis.keep = f;`,
			),
		);
		const source = emitVmDefinition(definition, { compiled: true });
		expect(source).toContain("= mal_vm_create_object_shaped(vm");
		expect(source).not.toContain("MalObject __stack_object_");
	});

	it("anchors conditional-return materialization to RETURN metadata and checks OOM", () => {
		const definition = compileSemanticProgramToVmDefinition(
			semantic(
				`function f(escape, value) { const o = { x: value, tag: "current" }; const alias = o; alias.x = value + 1; if (escape === 1) return alias; if (escape === 2) return o; return typeof o === "object" ? o.x : 0; } globalThis.keep = f;`,
			),
		);
		const fn = definition.functions.find(
			(candidate) => (candidate.stackObjectMaterializations?.length ?? 0) > 0,
		)!;
		expect(fn.stackObjectMaterializations).toHaveLength(2);
		for (const materialization of fn.stackObjectMaterializations!) {
			expect(fn.instructions[materialization.returnInstructionIndex]?.opcode).toBe(
				"RETURN",
			);
			expect(
				fn.stackObjectSites?.some(
					(site) => site.instructionIndex === materialization.allocationInstructionIndex,
				),
			).toBe(true);
		}

		const source = emitVmDefinition(definition, { compiled: true });
		expect(source).toContain("mal_vm_materialize_stack_object(vm, &__stack_object_");
		expect(source).toMatch(
			/mal_vm_materialize_stack_object\([^\n]+\);\n\s+if \(vm->completion\.kind == MAL_COMPLETION_THROW\)/,
		);
		expect(source).toMatch(/mal_ops_construct_result\(materialized_ret_\d+/);
	});

	it("serializes native stack metadata for frontend cache reuse", () => {
		const decoded = deserializeVmDefinition(
			compileSourceToBuffer(
				`function f(escape) { const o = { x: 1 }; if (escape) return o; return typeof o === "object" ? o.x : 0; } globalThis.keep = f;`,
			),
		);
		expect(decoded.functions.some((fn) => (fn.stackObjectSites?.length ?? 0) > 0)).toBe(
			true,
		);
		expect(
			decoded.functions.some((fn) => (fn.stackObjectAccesses?.length ?? 0) > 0),
		).toBe(true);
		expect(
			decoded.functions.some((fn) => (fn.stackObjectMaterializations?.length ?? 0) > 0),
		).toBe(true);
		expect(emitVmDefinition(decoded, { compiled: true })).toContain(
			"MalObject __stack_object_",
		);
	});
});
