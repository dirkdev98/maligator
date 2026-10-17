import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import {
	planDependencyChunks,
	restoreDependencyChunkPlan,
	storeDependencyChunkPlan,
} from "../src/dependency-chunks.ts";

const roots: Array<string> = [];

afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function write(file: string, source: string): void {
	mkdirSync(path.dirname(file), { recursive: true });
	writeFileSync(file, source);
}

/** Source of a given size in KiB, without code the planner would care about. */
function padding(kib: number): string {
	return `// ${"x".repeat(kib * 1024)}\n`;
}

/**
 * A CommonJS package of ten parts with a require cycle between parts 3 and 4 and an
 * ES module that part 6 requires, imported by an island entry. Both pairs are large
 * enough that a chunk boundary would fall between them if the planner allowed it.
 */
function packageIsland() {
	const root = mkdtempSync(path.join(os.tmpdir(), "mal-dependency-chunks-"));
	roots.push(root);
	const modules = path.join(root, "node_modules");
	write(path.join(modules, "big/package.json"), `{"main":"./index.js"}\n`);
	const parts = Array.from({ length: 10 }, (_, index) => `part${index}.js`);
	write(
		path.join(modules, "big/index.js"),
		`${parts.map((part) => `require("./${part}");`).join("\n")}\n`,
	);
	for (const [index, part] of parts.entries()) {
		const requires =
			index === 3
				? `require("./part4.js");`
				: index === 4
					? `require("./part3.js");`
					: index === 6
						? `require("esm-only");`
						: "";
		write(
			path.join(modules, "big", part),
			`${requires}\nexports.part = ${index};\n${padding(index === 3 || index === 4 ? 100 : 20)}`,
		);
	}
	write(
		path.join(modules, "esm-only/package.json"),
		`{"type":"module","exports":"./index.js"}\n`,
	);
	write(
		path.join(modules, "esm-only/index.js"),
		`export const value = 1;\n${padding(100)}`,
	);
	const target = path.join(modules, "big/index.js");
	const graph = buildModuleGraph(path.join(modules, "big/.island.mjs"), {
		entryGoal: "module",
		entrySource: `import "./index.js";\n`,
	});
	return { modules, target, graph };
}

describe("dependency chunk planning", () => {
	test("keeps cycles and required ES modules in one chunk and evaluates only targets", () => {
		const { modules, target, graph } = packageIsland();
		const plan = planDependencyChunks(graph, new Set([target]));

		expect(plan).toBeDefined();
		expect(plan!.chunks.length).toBeGreaterThan(1);
		const chunkOf = (module: string) =>
			plan!.chunks.findIndex((chunk) =>
				chunk.members.includes(path.join(modules, module)),
			);
		expect(chunkOf("big/part3.js")).toBe(chunkOf("big/part4.js"));
		expect(chunkOf("esm-only/index.js")).toBe(chunkOf("big/part6.js"));
		expect(plan!.chunks.flatMap((chunk) => chunk.members)).toEqual(
			graph.evaluationOrder.filter((module) => module !== graph.entry),
		);
		expect(plan!.chunks.flatMap((chunk) => chunk.imports)).toEqual([target]);
		expect(plan!.chunks.flatMap((chunk) => chunk.requiredRoots)).not.toContain(
			path.join(modules, "esm-only/index.js"),
		);
		expect(plan!.interfaces.get(path.join(modules, "big/part1.js"))).toEqual({
			goal: "cjs",
			exports: ["part"],
		});
	});

	test("leaves small islands whole", () => {
		const root = mkdtempSync(path.join(os.tmpdir(), "mal-dependency-chunks-"));
		roots.push(root);
		const target = path.join(root, "node_modules/small/index.js");
		write(target, `exports.value = 1;\n`);
		const graph = buildModuleGraph(path.join(root, "node_modules/small/.island.mjs"), {
			entryGoal: "module",
			entrySource: `import "./index.js";\n`,
		});

		expect(planDependencyChunks(graph, new Set([target]))).toBeUndefined();
	});

	test("stores plans relative to their package root", () => {
		const { modules, target, graph } = packageIsland();
		const plan = planDependencyChunks(graph, new Set([target]))!;
		const stored = storeDependencyChunkPlan(plan, modules);

		expect(JSON.stringify(stored)).not.toContain(modules);
		expect(restoreDependencyChunkPlan(stored, modules)).toEqual(plan);
	});
});
