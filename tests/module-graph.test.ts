import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { buildModuleGraph } from "../src/module-graph.ts";
import type { ModuleGraph } from "../src/module-graph.ts";

let root: string;

function write(relativePath: string, contents: string) {
	const full = path.join(root, relativePath);
	mkdirSync(path.dirname(full), { recursive: true });
	writeFileSync(full, contents);
}

beforeAll(() => {
	// A hermetic fixture tree in a temp dir: relative imports, a re-export, a
	// dynamic import, a node_modules package with an `exports` map, and a cycle.
	root = mkdtempSync(path.join(tmpdir(), "maligator-graph-"));

	write(
		"entry.mjs",
		`import { a } from "./a.mjs";
import { b } from "./b.mjs";
import { dep } from "pkg";
export { a as reA } from "./a.mjs";
async function load() {
	return (await import("./dynamic.mjs")).value;
}
globalThis.sink = [a, b, dep, load];
`,
	);
	write(
		"a.mjs",
		`import { b } from "./b.mjs";
import { cycleA } from "./cycle-a.mjs";
export const a = b + cycleA;
`,
	);
	write("b.mjs", `export const b = 1;\n`);
	write("dynamic.mjs", `export const value = 42;\n`);
	write(
		"cycle-a.mjs",
		`import { cycleB } from "./cycle-b.mjs";
export const cycleA = cycleB + 1;
`,
	);
	write(
		"cycle-b.mjs",
		`import { cycleA } from "./cycle-a.mjs";
export const cycleB = 2;
`,
	);
	write(
		"node_modules/pkg/package.json",
		JSON.stringify({ name: "pkg", type: "module", exports: { ".": "./index.mjs" } }),
	);
	write("node_modules/pkg/index.mjs", `export const dep = "dep";\n`);
});

afterAll(() => {
	if (root) {
		rmSync(root, { recursive: true, force: true });
	}
});

const rel = (absolute: string) => path.relative(root, absolute);
const pkgIndex = path.join("node_modules", "pkg", "index.mjs");

function depSummary(graph: ModuleGraph, modulePath: string) {
	return graph.modules
		.get(path.join(root, modulePath))!
		.dependencies.map((dependency) => ({
			specifier: dependency.specifier,
			kind: dependency.kind,
			resolved: dependency.resolvedPath ? rel(dependency.resolvedPath) : null,
		}));
}

test("discovers every reachable module, including dynamic + node_modules targets", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));

	const discovered = new Set([...graph.modules.keys()].map(rel));
	expect(discovered).toEqual(
		new Set([
			"entry.mjs",
			"a.mjs",
			"b.mjs",
			"dynamic.mjs",
			"cycle-a.mjs",
			"cycle-b.mjs",
			pkgIndex,
		]),
	);
});

test("detects goals by extension (.mjs => module)", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));

	expect(graph.modules.get(graph.entry)!.goal).toBe("module");
	expect(graph.modules.get(path.join(root, pkgIndex))!.goal).toBe("module");
});

test("records dependency specifiers, kinds, and resolutions", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));

	expect(depSummary(graph, "entry.mjs")).toEqual([
		{ specifier: "./a.mjs", kind: "import", resolved: "a.mjs" },
		{ specifier: "./b.mjs", kind: "import", resolved: "b.mjs" },
		{ specifier: "pkg", kind: "import", resolved: pkgIndex },
		{ specifier: "./a.mjs", kind: "export", resolved: "a.mjs" },
		{ specifier: "./dynamic.mjs", kind: "dynamic", resolved: "dynamic.mjs" },
	]);
});

test("evaluation order puts static dependencies before dependents, entry last", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));
	const order = graph.evaluationOrder.map(rel);

	expect(order.at(-1)).toBe("entry.mjs");

	const before = (earlier: string, later: string) =>
		order.indexOf(earlier) < order.indexOf(later);
	expect(before("b.mjs", "a.mjs")).toBe(true);
	expect(before("a.mjs", "entry.mjs")).toBe(true);
	expect(before("b.mjs", "entry.mjs")).toBe(true);
	expect(before(pkgIndex, "entry.mjs")).toBe(true);

	// A dynamically imported module is evaluated when import() runs, not as part
	// of the static evaluation order.
	expect(order).not.toContain("dynamic.mjs");
});

test("detects the cycle as a strongly-connected component", () => {
	const graph = buildModuleGraph(path.join(root, "entry.mjs"));

	const cycleSets = graph.cycles.map((component) => new Set(component.map(rel)));
	expect(cycleSets).toContainEqual(new Set(["cycle-a.mjs", "cycle-b.mjs"]));
});
