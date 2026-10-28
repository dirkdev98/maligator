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

const derivedSource = `
	class Base {
		constructor(target) {
			return target;
		}
	}
	class Guarded extends Base {
		#mark = 1;
		constructor(target) {
			try {
				super(target);
			} catch {}
			this.#mark = 2;
		}
		mark() { return this.#mark; }
	}
	class Direct extends Base {
		#tag = 1;
		constructor(target) {
			super(target);
			this.#tag = 2;
		}
		tag() { return this.#tag; }
	}
	class Outer {
		#shared = 1;
		shared() { return this.#shared; }
		static Inner = class extends Base {
			constructor(target) {
				super(target);
				this.#shared = 2;
			}
		};
	}
	globalThis.classes = [Guarded, Direct, Outer];`;

const brandSource = `
	class Holders {
		#list = [];
		#counts = new Int32Array(4);
		#late;
		#early;
		#copied;
		#either;
		constructor(flag) {
			this.#late = Array.from([1, 2]);
			this.#copied = this.#list;
			this.#either = flag ? [] : new Int32Array(1);
			this.observe();
			this.#early = [];
		}
		observe() {}
		list() { return this.#list; }
		counts() { return this.#counts; }
		late() { return this.#late; }
		early() { return this.#early; }
		copied() { return this.#copied; }
		either() { return this.#either; }
	}
	globalThis.holders = new Holders(true);`;

const elementSource = `
	class Elements {
		#ids = [];
		#mixed = [1];
		#alias;
		#returned = [];
		#keyed = [];
		#visited = [2];
		#kept = [3];
		constructor() {
			for (let index = 0; index < 4; index++) this.#ids.push(index * 2);
			this.#alias = this.#mixed;
		}
		relabel() { this.#alias.push("label"); }
		set(key) { this.#keyed[key] = 1; }
		visit() { this.#visited.forEach((value, index, array) => { array[index] = value; }); }
		returned() { return this.#returned; }
		merge() { return this.#returned.concat(this.#kept); }
		ids() { return this.#ids[1]; }
		mixed() { return this.#mixed[0]; }
		keyed() { return this.#keyed[0]; }
		visited() { return this.#visited[0]; }
		kept() { return this.#kept[0]; }
	}
	globalThis.elements = new Elements();`;

function fieldFacts(evalMode: "disabled" | "runtime", program = source) {
	const core = constructSemanticProgramCore(
		analyzeSourceAndRunSemanticAnalysis(program, "/fields.js"),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({
					engine: { primordials: "locked", eval: evalMode === "disabled" ? false : true },
				}),
			),
		},
		(_phase, run) => run(),
	);
	const facts = analyzeCorePrivateFields(core.program, core.context);
	if (facts === undefined) return undefined;
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
			brand: undefined,
			constructionOnly: true,
		});
		expect(fields.get("count")).toEqual({
			kinds: COMPILER_VALUE_KIND_NUMBER,
			brand: undefined,
			constructionOnly: false,
		});
		expect(fields.get("value")).toEqual({
			kinds: COMPILER_VALUE_KIND_TOP,
			brand: undefined,
			constructionOnly: true,
		});
		expect(fields.get("mixed")).toEqual({
			kinds: COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_STRING,
			brand: undefined,
			constructionOnly: false,
		});
	});

	it("drop the initial undefined that the constructor overwrites before anything reads it", () => {
		const fields = fieldFacts("disabled")!;
		expect(fields.get("items")).toEqual({
			kinds: COMPILER_VALUE_KIND_OBJECT,
			brand: "Array",
			constructionOnly: true,
		});
		const holders = fieldFacts("disabled", brandSource)!;
		expect(holders.get("late")?.kinds).toBe(COMPILER_VALUE_KIND_OBJECT);
		expect(holders.get("early")?.kinds).toBe(
			COMPILER_VALUE_KIND_UNDEFINED | COMPILER_VALUE_KIND_OBJECT,
		);
	});

	it("give a field the class all of its values share", () => {
		const fields = fieldFacts("disabled", brandSource)!;
		expect(fields.get("list")?.brand).toBe("Array");
		expect(fields.get("counts")?.brand).toBe("Int32Array");
		expect(fields.get("late")?.brand).toBe("Array");
		expect(fields.get("copied")?.brand).toBe("Array");
		expect(fields.get("either")?.brand).toBeUndefined();
		expect(fields.get("early")?.brand).toBeUndefined();
	});

	it("count a derived constructor's store only after its own definition of the field", () => {
		const fields = fieldFacts("disabled", derivedSource)!;
		expect(fields.get("mark")?.constructionOnly).toBe(false);
		expect(fields.get("tag")?.constructionOnly).toBe(true);
		expect(fields.get("shared")?.constructionOnly).toBe(false);
	});

	it("retains collection brands across publication and replacement with the same class", () => {
		const fields = fieldFacts(
			"disabled",
			`
			class Collections {
				#map = new Map();
				#set = new Set();
				#copy;
				#wrapped = new Proxy(new Map(), {});
				#mixed = new Map();
				constructor(visit) { this.#copy = this.#map; visit(this.#map, this.#set); }
				reset() { this.#map = new Map(); this.#mixed = new Set(); }
				map() { return this.#map; }
				set() { return this.#set; }
				copy() { return this.#copy; }
				wrapped() { return this.#wrapped; }
				mixed() { return this.#mixed; }
			}
			globalThis.Collections = Collections;`,
		)!;
		expect(fields.get("map")).toMatchObject({ brand: "Map", constructionOnly: false });
		expect(fields.get("set")?.brand).toBe("Set");
		expect(fields.get("copy")?.brand).toBe("Map");
		expect(fields.get("wrapped")?.brand).toBeUndefined();
		expect(fields.get("mixed")?.brand).toBeUndefined();
	});

	it("join the kinds of every element stored into arrays that only private fields hold", () => {
		const fields = fieldFacts("disabled", elementSource)!;
		expect(fields.get("ids")?.elements).toBe(
			COMPILER_VALUE_KIND_NUMBER | COMPILER_VALUE_KIND_UNDEFINED,
		);
		expect(fields.get("mixed")?.elements).toBe(
			COMPILER_VALUE_KIND_NUMBER |
				COMPILER_VALUE_KIND_STRING |
				COMPILER_VALUE_KIND_UNDEFINED,
		);
	});

	it("leave elements unknown when other code can reach the array or name another property", () => {
		const fields = fieldFacts("disabled", elementSource)!;
		expect(fields.get("returned")?.elements).toBeUndefined();
		expect(fields.get("keyed")?.elements).toBeUndefined();
		expect(fields.get("visited")?.elements).toBeUndefined();
		expect(fields.get("kept")?.elements).toBeUndefined();
	});

	it("give no facts when direct eval could write private fields", () => {
		expect(fieldFacts("runtime")).toBeUndefined();
	});
});
