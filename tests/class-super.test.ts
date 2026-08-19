import { expect, test } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";
import { deserializeVmDefinition, serializeVmDefinition } from "../src/serialize-vm.ts";

function compile(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"class-super.js",
		parseScript(source, { strict: true }),
	);
	return compileSemanticProgramToIr(semantic);
}

test("super reads retain their receiver through IR, lowering, and wire encoding", () => {
	const ir = compile(`
		class B { get x() { return this.value; } }
		class D extends B {
			read(k) { return super[k]; }
			call() { return super.x(); }
			compound() { return super.x += 1; }
			logical() { return super.x ||= 1; }
			update() { return super.x++; }
			tagged() { return super.x\`tag\`; }
			optional() { return super.x?.(); }
		}
	`);
	const superLoads = ir.functions
		.flatMap((fn) => fn.blocks)
		.flatMap((block) => block.instructions)
		.filter((instruction) => instruction.type === "loadSuperProperty");
	expect(superLoads.length).toBeGreaterThanOrEqual(7);
	for (const load of superLoads) {
		expect(load.registers).toHaveLength(4);
	}

	const vm = compileSemanticProgramToVmDefinition(ir.semantic);
	const lowered = vm.functions.flatMap((fn) => fn.instructions);
	expect(
		lowered.filter((instruction) => instruction.opcode === "LOAD_SUPER_PROPERTY"),
	).toHaveLength(superLoads.length);
	const roundTripped = deserializeVmDefinition(serializeVmDefinition(vm));
	expect(
		roundTripped.functions
			.flatMap((fn) => fn.instructions)
			.filter((instruction) => instruction.opcode === "LOAD_SUPER_PROPERTY"),
	).toEqual(
		lowered.filter((instruction) => instruction.opcode === "LOAD_SUPER_PROPERTY"),
	);
});

test("object literal methods are non-constructible without depending on sibling super use", () => {
	const withoutSuper = compile(`const object = { method() {} };`);
	const withSuper = compile(
		`const object = { method() {}, other() { return super.x; } };`,
	);
	expect(withoutSuper.functions[1]?.hasPrototype).toBe(false);
	expect(withSuper.functions[1]?.hasPrototype).toBe(false);
});

test("class heritage defines the constructor prototype without ordinary assignment", () => {
	const ir = compile(`class B {}; class D extends B {}`);
	const prototypeDefinitions = ir.functions
		.flatMap((fn) => fn.blocks)
		.flatMap((block) => block.instructions)
		.filter(
			(instruction) =>
				instruction.type === "defineProperty" && instruction.writable === false,
		);
	expect(prototypeDefinitions).toHaveLength(1);
	expect(prototypeDefinitions[0]).toMatchObject({
		type: "defineProperty",
		enumerable: false,
		writable: false,
		configurable: false,
	});

	const roundTripped = deserializeVmDefinition(
		serializeVmDefinition(compileSemanticProgramToVmDefinition(ir.semantic)),
	);
	expect(
		roundTripped.functions
			.flatMap((fn) => fn.instructions)
			.filter(
				(instruction) =>
					instruction.opcode === "DEFINE_PROPERTY" && !instruction.writable,
			),
	).toHaveLength(1);
});
