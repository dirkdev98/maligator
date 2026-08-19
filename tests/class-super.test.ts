import { expect, test } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { lowerSemanticProgramToCore } from "../src/core-frontend.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";
import { deserializeVmDefinition, serializeVmDefinition } from "../src/serialize-vm.ts";

function compile(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"class-super.js",
		parseScript(source, { strict: true }),
	);
	return { core: lowerSemanticProgramToCore(semantic), semantic };
}

test("super reads retain their receiver through Core, lowering, and wire encoding", () => {
	const { core, semantic } = compile(`
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
	const superLoads = core.functions
		.flatMap((fn) => fn.blocks)
		.flatMap((block) => block.instructions)
		.filter((instruction) => instruction.opcode === "loadSuperProperty");
	expect(superLoads.length).toBeGreaterThanOrEqual(7);
	for (const load of superLoads) {
		expect(load.inputs).toHaveLength(3);
		expect(load.outputs).toHaveLength(1);
	}

	const vm = compileSemanticProgramToVmDefinition(semantic);
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
	const withoutSuper = compile(`const object = { method() {} };`).core;
	const withSuper = compile(
		`const object = { method() {}, other() { return super.x; } };`,
	).core;
	expect(withoutSuper.functions[1]?.metadata.hasPrototype).toBe(false);
	expect(withSuper.functions[1]?.metadata.hasPrototype).toBe(false);
});

test("class heritage defines the constructor prototype without ordinary assignment", () => {
	const { core, semantic } = compile(`class B {}; class D extends B {}`);
	const prototypeDefinitions = core.functions
		.flatMap((fn) => fn.blocks)
		.flatMap((block) => block.instructions)
		.filter(
			(instruction) =>
				instruction.opcode === "defineProperty" &&
				instruction.attributes.writable === false,
		);
	expect(prototypeDefinitions).toHaveLength(1);
	expect(prototypeDefinitions[0]?.opcode).toBe("defineProperty");
	expect(prototypeDefinitions[0]?.attributes).toMatchObject({
		enumerable: false,
		writable: false,
		configurable: false,
	});

	const roundTripped = deserializeVmDefinition(
		serializeVmDefinition(compileSemanticProgramToVmDefinition(semantic)),
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
