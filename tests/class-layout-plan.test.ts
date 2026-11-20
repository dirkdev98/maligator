import { expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
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
import type { ProgramImage } from "../src/compiler/target/program-image.ts";

function compile(source: string): ProgramImage {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/class-layout-plan.mjs",
		parseModule(source),
	);
	return compileSemanticProgramToProgramImage(semantic);
}

function layoutNames(image: ProgramImage): Array<Array<string>> {
	const text = (index: number) =>
		String.fromCharCode(...(image.runtime.stringConstants[index] ?? []));
	return (image.native.classLayouts ?? []).map((layout) =>
		layout.keys.map((key) => (key < 0 ? "#" : text(key))),
	);
}

function classLayoutSites(image: ProgramImage): Array<string> {
	return image.native.functions.flatMap((fn) =>
		fn.instructions.flatMap((plan, ip) =>
			plan?.kind === "class-layout"
				? [`${fn.body.instructions[ip]!.opcode}:${plan.site.kind}`]
				: [],
		),
	);
}

const source = `
	class Point {
		#tag = 1;
		x = 0;
		constructor(x, y) { this.x = x; this.y = y; }
		norm() { return this.x * this.x + this.y * this.y; }
		tag() { return this.#tag; }
	}
	class Point3 extends Point {
		constructor(x, y, z) { super(x, y); this.z = z; }
		norm() { return super.norm() + this.z * this.z; }
	}
	class Partial {
		constructor(flag) { this.a = 1; if (flag) this.b = 2; this.c = 3; }
		sum() { return this.a + this.c; }
	}
	const points = [new Point(1, 2), new Point3(1, 2, 3), new Partial(true)];
	let total = 0;
	for (const point of points) total += point.norm?.() ?? point.sum();
	globalThis.total = total + points[0].tag();
`;

test("class layouts follow constructor key order and stop at conditional keys", () => {
	const image = compile(source);
	expect(layoutNames(image)).toEqual(
		expect.arrayContaining([
			// The class brand precedes its private field.
			["#", "#", "x", "y"],
			["#", "#", "x", "y", "z"],
			["a"],
		]),
	);
});

test("method bodies guard their receiver's fields and methods, constructors do not", () => {
	const image = compile(source);
	const sites = classLayoutSites(image);
	expect(sites).toContain("LOAD_PROPERTY_STATIC:slot");
	expect(sites).toContain("LOAD_PROPERTY_STATIC:method");
	expect(sites).toContain("LOAD_PRIVATE:slot");
	expect(sites.some((site) => site.startsWith("STORE_PROPERTY_STATIC"))).toBe(false);
	const roundTripped = deserializeCompilerArtifact(serializeCompilerArtifact(image));
	expect(roundTripped.native.classLayouts).toEqual(image.native.classLayouts);
	expect(classLayoutSites(roundTripped)).toEqual(sites);
});

test("a name that plain objects own as data keeps its guard only where it is called", () => {
	const image = compile(`
		class Kernel {
			#ops = [1, 2];
			opcode(index) { return this.#ops[index]; }
		}
		const columns = { opcode: [3, 4] };
		function read(kernel, index) { return kernel.opcode(index) + columns.opcode[index]; }
		globalThis.total = read(new Kernel(), 1);
	`);
	const name = (index: number) =>
		String.fromCharCode(...(image.runtime.stringConstants[index] ?? []));
	const read = image.native.functions.find(
		(fn) => name(fn.body.nameStringIndex) === "read",
	)!;
	const sites = read.instructions.flatMap((plan, ip) =>
		plan?.kind === "class-layout"
			? [`${read.body.instructions[ip]!.opcode}:${plan.site.kind}`]
			: [],
	);
	expect(sites).toEqual(["LOAD_PROPERTY_STATIC:method"]);
});

test("classes in a function scope extend their parent's layout and reserve it in the base receiver", () => {
	const image = compile(`
		function make(value) {
			class Base { constructor(x) { this.x = x; } }
			class Derived extends Base { constructor(x) { super(x); this.y = x + 1; } }
			return new Derived(value);
		}
		globalThis.made = make(1);
	`);
	expect(layoutNames(image)).toEqual(expect.arrayContaining([["x"], ["x", "y"]]));
	const name = (index: number) =>
		String.fromCharCode(...(image.runtime.stringConstants[index] ?? []));
	const base = image.native.functions.find(
		(fn) => name(fn.body.nameStringIndex) === "Base",
	)!;
	expect(base.body.constructorSlotReserve).toBe(2);
});

test("a name-guessed method site skips receivers Core proves are Arrays or collections", () => {
	const sourcePath = "/class-layout-brands.mjs";
	const source = `
		class Bag {
			#items = [];
			push(value) { this.#items.push(value); return this; }
			has(value) { return this.#items.includes(value); }
			get(index) { return this.#items[index]; }
		}
		function fill(bag, values) {
			const seen = new Set();
			const list = [];
			const index = new Map();
			for (const value of values) {
				if (seen.has(value) || bag.has(value)) continue;
				seen.add(value);
				list.push(value);
				index.set(value, list.length);
			}
			return index.get(values[0]) + list.length;
		}
		globalThis.total = fill(new Bag().push(3), [1, 2, 1, 3]);
	`;
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, sourcePath, parseModule(source)),
		{
			facts: withProgramClosure(
				compilerProgramFactsFromConfig(resolveBuildConfig({})),
				programClosureCertificate({ kind: "whole-program", entry: sourcePath }, [], []),
			),
		},
	);
	const name = (index: number) =>
		String.fromCharCode(...(image.runtime.stringConstants[index] ?? []));
	const fill = image.native.functions.find(
		(fn) => name(fn.body.nameStringIndex) === "fill",
	)!;
	const guarded = fill.instructions.flatMap((plan, ip) => {
		const instruction = fill.body.instructions[ip]!;
		return plan?.kind === "class-layout" && instruction.opcode === "LOAD_PROPERTY_STATIC"
			? [name(instruction.stringIndex)]
			: [];
	});
	expect(guarded).toEqual(["has"]);
});
