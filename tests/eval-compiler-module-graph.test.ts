import * as path from "node:path";
import { expect, test } from "vitest";
import { stripCompactTypes } from "../src/compiler/frontend/compact-type-strip.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";

test("keeps closed-world planning outside the eval compiler import graph", () => {
	const graph = buildModuleGraph(
		path.resolve("src/compiler/pipeline/eval-compiler-entry.mts"),
		{ stripTypes: stripCompactTypes },
	);
	for (const file of [
		"src/compiler/target/mapped-function-array-hints.ts",
		"src/compiler/core/core-rest-iteration.ts",
	])
		expect(graph.modules.has(path.resolve(file))).toBe(false);
}, 30_000);
