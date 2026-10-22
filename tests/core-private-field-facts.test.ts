import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { analyzeCorePrivateFields } from "../src/compiler/core/core-private-field-analysis.ts";
import type { CorePrivateFieldFact } from "../src/compiler/core/core-private-field-facts.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { constructSemanticProgramCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../src/compiler/shared/compiler-value-kinds.ts";

const source = `
	class Fields {
		#flag = true;
		#count = 0;
		#items;
		#value;
		#mixed = 1;
		constructor(value) {
			this.#items = [];
			this.#value = value;
		}
		bump() { this.#count = this.#count + 1; }
		relabel() { this.#mixed = "label"; }
		flag() { return this.#flag; }
		count() { return this.#count; }
		items() { return this.#items; }
		value() { return this.#value; }
		mixed() { return this.#mixed; }
	}
	globalThis.fields = new Fields(3);`;

function fieldFacts(evalMode: "disabled" | "runtime") {
	const core = constructSemanticProgramCore(
		analyzeSourceAndRunSemanticAnalysis(source, "/fields.js"),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { eval: evalMode === "disabled" ? false : true } }),
			),
		},
		(_phase, run) => run(),
	);
	const facts = analyzeCorePrivateFields(core.program, core.context);
	if (facts === undefined) return undefined;
	// Each accessor method's single private read names the field it is called after.
	const byMethod = new Map<string, CorePrivateFieldFact | undefined>();
	for (const id of core.program.functionIds()) {
		const fn = core.program.function(id);
		const units = core.program.stringConstants[fn.metadata.nameStringIndex];
		const name = units === undefined ? undefined : String.fromCharCode(...units);
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "loadPrivate" ||
				name === undefined
			)
				continue;
			const key = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + 1);
			byMethod.set(name, facts.field(fn, key));
		}
	}
	return byMethod;
}

describe("private field facts", () => {
	it("join the kinds every write stores and note construction-only fields", () => {
		const fields = fieldFacts("disabled")!;
		expect(fields.get("flag")).toEqual({
			kinds: COMPILER_VALUE_KIND_BOOLEAN,
			constructionOnly: true,
		});
		expect(fields.get("count")).toEqual({
			kinds: COMPILER_VALUE_KIND_NUMBER,
			constructionOnly: false,
		});
		expect(fields.get("items")).toEqual({
			kinds: COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_OBJECT,
			constructionOnly: true,
		});
		expect(fields.get("value")).toEqual({
			kinds: COMPILER_VALUE_KIND_TOP,
			constructionOnly: true,
		});
		expect(fields.get("mixed")).toEqual({
			kinds: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
			constructionOnly: false,
		});
	});

	it("give no facts when direct eval could write private fields", () => {
		expect(fieldFacts("runtime")).toBeUndefined();
	});
});
