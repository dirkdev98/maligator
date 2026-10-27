import { describe, expect, it } from "vitest";
import { CoreFunctionBuilder } from "../src/compiler/core/core-builder.ts";
import { analyzeCoreConditionalValueKinds } from "../src/compiler/core/core-conditional-value-kinds.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { analyzeCoreValueKinds } from "../src/compiler/core/core-ir-value-kinds.ts";
import { coreInstructionId } from "../src/compiler/core/core-ir.ts";
import { coreInstructionFacts } from "../src/compiler/core/core-native-instruction-facts.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN as BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER as NUMBER,
	COMPILER_VALUE_KIND_BIGINT as BIGINT,
	COMPILER_VALUE_KIND_SYMBOL as SYMBOL,
	COMPILER_VALUE_KIND_STRING as STRING,
	COMPILER_VALUE_KIND_OBJECT as OBJECT,
	COMPILER_VALUE_KIND_TOP as TOP,
	COMPILER_VALUE_KIND_NULLISH as NULLISH,
} from "../src/compiler/shared/compiler-value-kinds.ts";
import {
	INSTRUCTION_MAY_THROW,
	INSTRUCTION_MAY_GC,
	INSTRUCTION_CALLS_USER_CODE,
	instructionResultKind,
	instructionInputKind,
} from "../src/compiler/shared/instruction-facts.ts";
import {
	serializeCompilerArtifact,
	deserializeCompilerArtifact,
} from "../src/compiler/target/compiler-artifact-codec.ts";
import { nativeVariantContract } from "../src/compiler/target/lower-native-storage.ts";
import { analysisProgram } from "./helpers/core-program-analysis.ts";
import {
	inspectStaticValueFunction,
	inspectStaticValueFunctions,
} from "./helpers/static-values.ts";
const effects = INSTRUCTION_MAY_THROW | INSTRUCTION_MAY_GC | INSTRUCTION_CALLS_USER_CODE;

describe("primitive delete facts", () => {
	it.each([
		NUMBER,
		BOOLEAN,
		BIGINT,
		SYMBOL,
		NUMBER | BOOLEAN | BIGINT | SYMBOL,
		STRING,
		NULLISH,
		OBJECT,
		TOP,
	])("keeps normal Boolean results independent of receiver mask %i", (receiver) => {
		const program = analysisProgram(),
			builder = new CoreFunctionBuilder(program, { parameterCount: 2 });
		const block = builder.createBlock([{}, {}]);
		const [result] = builder.appendInstruction(block, "deleteProperty", [
			builder.blockParameterValue(block, 0),
			builder.blockParameterValue(block, 1),
		]);
		builder.setTerminator(block, { kind: "return", value: result! });
		const fn = program.function(builder.finish(block).function),
			cfg = buildCoreControlFlow(program, fn.id);
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(result!));
		for (const key of [STRING, OBJECT]) {
			const kinds = analyzeCoreValueKinds(program, fn, cfg, {
				parameterMasks: [receiver, key],
			});
			const conditional = analyzeCoreConditionalValueKinds(program, fn, cfg, (value) =>
				kinds.kindMask(value),
			);
			const canonical = coreInstructionFacts(
				program,
				fn,
				instruction,
				kinds,
				conditional,
				false,
			);
			const selected = coreInstructionFacts(
				program,
				fn,
				instruction,
				kinds,
				conditional,
				true,
			);
			expect(kinds.kindMask(result!)).toBe(BOOLEAN);
			expect(canonical.effectMask & effects).toBe(effects);
			const empty = [
				NUMBER,
				BOOLEAN,
				BIGINT,
				SYMBOL,
				NUMBER | BOOLEAN | BIGINT | SYMBOL,
			].includes(receiver);
			expect(selected.effectMask & effects).toBe(empty && key === STRING ? 0 : effects);
		}
	});
	it.each(["+value", "!value", "value?1n:2n", "value?false:1n"])(
		"preserves unknown key effects while deleting from %s",
		(target) => {
			const out = inspectStaticValueFunction(
				`globalThis.compute=function compute(value,key,observe){const target=${target};observe(target);return delete target[key];};`,
				"compute",
				{ locked: false },
			);
			expect(out.core.some((op) => op.opcode === "deleteProperty")).toBe(false);
			expect(out.core.filter((op) => op.opcode === "toPropertyKey")).toHaveLength(1);
			for (const image of [
				out.image,
				deserializeCompilerArtifact(serializeCompilerArtifact(out.image)),
			]) {
				const fn = image.native.functions[out.native.functionIndex]!;
				const ip = fn.body.instructions.findIndex(
					(op) => op.opcode === "TO_PROPERTY_KEY",
				);
				expect(ip).toBeGreaterThanOrEqual(0);
				expect(fn.facts![ip]!.effectMask! & effects).toBe(effects);
			}
		},
	);
	it.each(
		["function", "function*", "async function", "async function*"].flatMap(
			(declaration) => [false, true].map((locked) => ({ declaration, locked })),
		),
	)("keeps key conversion in $declaration locked=$locked", ({ declaration, locked }) => {
		const suspend = declaration.includes("*")
			? "yield observe(target);"
			: declaration.startsWith("async")
				? "await observe(target);"
				: "observe(target);";
		const out = inspectStaticValueFunction(
			`globalThis.compute=${declaration} compute(value,key,observe){const target=+value;${suspend}return delete target[key];};`,
			"compute",
			{ locked },
		);
		expect(out.core.some((op) => op.opcode === "deleteProperty")).toBe(false);
		expect(out.core.filter((op) => op.opcode === "toPropertyKey")).toHaveLength(1);
	});
	it.each(["value", "value+':'", "value?null:undefined"])(
		"retains the delete operation for %s",
		(target) => {
			const out = inspectStaticValueFunction(
				`globalThis.compute=function compute(value,key,observe){const target=${target};observe(target);return delete target[key];};`,
				"compute",
				{ locked: false },
			);
			expect(out.core.some((op) => op.opcode === "deleteProperty")).toBe(true);
			const ip = out.native.body.instructions.findIndex(
				(op) => op.opcode === "DELETE_PROPERTY",
			);
			const op = out.native.body.instructions[ip]!;
			if (op.opcode !== "DELETE_PROPERTY") throw new Error("Missing deletion");
			expect(instructionResultKind(out.native.facts?.[ip], op.dst)).toBe(BOOLEAN);
			expect(out.native.facts![ip]!.effectMask! & effects).toBe(effects);
		},
	);
	it.each(["number", "boolean", "bigint", "symbol"])(
		"uses a dominating %s bound without weakening the key conversion",
		(type) => {
			const out = inspectStaticValueFunction(
				`globalThis.compute=function compute(value,key,observe){if(typeof value==='${type}'){observe(value);return delete value[key];}return false;};`,
				"compute",
				{ locked: false },
			);
			expect(out.core.some((op) => op.opcode === "deleteProperty")).toBe(false);
			expect(out.core.filter((op) => op.opcode === "toPropertyKey")).toHaveLength(1);
		},
	);
	it("preserves a caught key throw after splitting the deletion", () => {
		const out = inspectStaticValueFunction(
			`globalThis.compute=function compute(value,key,observe){const target=+value;try{return delete target[key];}catch(e){return observe(e);}};`,
			"compute",
			{ locked: false },
		);
		expect(out.core.some((op) => op.opcode === "deleteProperty")).toBe(false);
		expect(out.native.body.handlers.length).toBeGreaterThan(0);
		const ip = out.native.body.instructions.findIndex(
			(op) => op.opcode === "TO_PROPERTY_KEY",
		);
		expect(out.native.facts![ip]!.effectMask! & effects).toBe(effects);
	});
	it.each(["key", "'field'"])(
		"refines selected deletion effects for %s while the public body remains general",
		(argument) => {
			const all = inspectStaticValueFunctions(
				`const leaf=function leaf(value,key){return delete value[key];};globalThis.compute=function compute(value,key){return leaf(+value,${argument});};globalThis.keep=leaf;`,
				["leaf", "compute"],
				{ locked: false },
			);
			const leaf = all.get("leaf")!.native;
			const ip = leaf.body.instructions.findIndex(
				(op) => op.opcode === "DELETE_PROPERTY",
			);
			const op = leaf.body.instructions[ip]!;
			if (op.opcode !== "DELETE_PROPERTY") throw new Error("Missing deletion");
			expect(instructionInputKind(leaf.facts?.[ip], op.object)).toBe(TOP);
			const entry = leaf.directEntries.find(
				(e) => e.parameterRepresentations[0] === "number",
			);
			expect(entry).toBeDefined();
			const facts = nativeVariantContract(leaf, entry!).facts![ip]!;
			expect(instructionInputKind(facts, op.object)).toBe(NUMBER);
			expect(facts.effectMask! & effects).toBe(argument === "key" ? effects : 0);
		},
	);
});
