import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { moduleImageComponents } from "../src/linked-images.ts";

const temporaryDirectories: Array<string> = [];

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function project(files: Record<string, string>): (name: string) => string {
	const root = mkdtempSync(path.join(os.tmpdir(), "maligator-linked-images-"));
	temporaryDirectories.push(root);
	writeFileSync(path.join(root, "package.json"), `{"type":"module"}\n`);
	for (const [name, source] of Object.entries(files)) {
		writeFileSync(path.join(root, name), source);
	}
	return (name) => path.join(root, name);
}

function componentNames(
	file: (name: string) => string,
	root: string,
	members: Array<string>,
): Array<Array<string>> | undefined {
	return moduleImageComponents(
		buildModuleGraph(file(root)),
		new Set(members.map(file)),
	)?.map((component) => component.map((module) => path.basename(module)));
}

describe("module image components", () => {
	test("orders each module after the modules it imports and groups import cycles", () => {
		const file = project({
			"entry.mjs": `import "./b.mjs";\nimport "./c.mjs";\n`,
			"a.mjs": `export const a = 1;\n`,
			"b.mjs": `import { a } from "./a.mjs";\nimport { c } from "./c.mjs";\nexport const b = a;\n`,
			"c.mjs": `import { d } from "./d.mjs";\nexport const c = () => d;\n`,
			"d.mjs": `import { c } from "./c.mjs";\nexport const d = () => c;\n`,
		});

		expect(
			componentNames(file, "entry.mjs", ["a.mjs", "b.mjs", "c.mjs", "d.mjs"]),
		).toEqual([["a.mjs"], ["d.mjs", "c.mjs"], ["b.mjs"]]);
	});

	test("keeps modules joined by a dynamic import in one image", () => {
		const file = project({
			"entry.mjs": `import "./a.mjs";\n`,
			"a.mjs": `export const load = () => import("./b.mjs");\n`,
			"b.mjs": `export const b = 1;\n`,
		});

		expect(componentNames(file, "entry.mjs", ["a.mjs", "b.mjs"])).toBeUndefined();
	});
});
