import { expect, test } from "vitest";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
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
