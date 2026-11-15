import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { lowerSemanticProgramToCore } from "../src/compiler/core/core-frontend.ts";
import { runSemanticAnalysisForGraph } from "../src/compiler/frontend/analyze-module-graph.ts";
import {
	buildModuleGraph,
	ModuleParseCache,
} from "../src/compiler/frontend/module-graph.ts";
import { coreFunctionNamed } from "./helpers/core-inspection.ts";

const directory = mkdtempSync(join(tmpdir(), "mal-commonjs-arguments-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));
const source = `module.exports = function mapped(value) {
	value = 9;
	arguments[0] = 12;
	return [value, arguments];
};`;

describe.each([false, true])("CommonJS arguments with prelude %s", (prelude) => {
	const entryPrelude = prelude
		? { specifier: "maligator:arguments-prelude", source: "export {};" }
		: undefined;

	it.each(["entry", "require", "import"])(
		"maps sloppy parameters reached through %s",
		(route) => {
			const target = join(directory, `sloppy-${route}-${prelude}.cjs`);
			writeFileSync(target, source);
			const entry =
				route === "entry"
					? target
					: join(
							directory,
							`entry-${route}-${prelude}.${route === "require" ? "cjs" : "mjs"}`,
						);
			if (route !== "entry") {
				writeFileSync(
					entry,
					route === "import"
						? `import run from ${JSON.stringify(target)}; globalThis.run = run;`
						: `"use strict"; module.exports = require(${JSON.stringify(target)});`,
				);
			}
			const graph = buildModuleGraph(entry, { entryPrelude });
			expect(graph.modules.get(target)?.parsed.strict).toBe(false);
			const program = lowerSemanticProgramToCore(
				runSemanticAnalysisForGraph(graph),
			).program;
			const fn = coreFunctionNamed(program, "mapped");
			expect(fn?.metadata.strict).toBe(false);
			expect(fn?.metadata.mappedArguments).toBe(true);
		},
	);

	it.each(['"use strict";', '"custom directive"; "use strict";'])(
		"keeps the wrapper and its functions strict after %s",
		(directive) => {
			const entry = join(directory, `strict-${prelude}.cjs`);
			writeFileSync(entry, directive + source);
			const graph = buildModuleGraph(entry, { entryPrelude });
			expect(graph.modules.get(entry)?.parsed.strict).toBe(true);
			const program = lowerSemanticProgramToCore(
				runSemanticAnalysisForGraph(graph),
			).program;
			const fn = coreFunctionNamed(program, "mapped");
			expect(fn?.metadata.strict).toBe(true);
			expect(fn?.metadata.mappedArguments).toBe(false);
		},
	);

	it("enforces a strict CommonJS directive before injecting its prelude", () => {
		const entry = join(directory, `strict-error-${prelude}.cjs`);
		writeFileSync(entry, '"use strict"; function duplicate(value, value) {}');
		expect(() => buildModuleGraph(entry, { entryPrelude })).toThrow(SyntaxError);
	});
});

it.each([
	["value", '"use strict";'],
	["value = 1", ""],
	["value, ...rest", ""],
	["{ value }", ""],
] as const)("does not map parameters in function (%s) {%s}", (parameters, directive) => {
	const entry = join(directory, "unmapped.cjs");
	writeFileSync(
		entry,
		`module.exports = function unmapped(${parameters}) { ${directive} return arguments; };`,
	);
	const program = lowerSemanticProgramToCore(
		runSemanticAnalysisForGraph(buildModuleGraph(entry)),
	).program;
	expect(coreFunctionNamed(program, "unmapped")?.metadata.mappedArguments).toBe(false);
});

it("keeps ES module functions strict and unmapped", () => {
	const entry = join(directory, "unmapped.mjs");
	writeFileSync(entry, "export function unmapped(value) { return arguments; }");
	const program = lowerSemanticProgramToCore(
		runSemanticAnalysisForGraph(buildModuleGraph(entry)),
	).program;
	const fn = coreFunctionNamed(program, "unmapped");
	expect(fn?.metadata.strict).toBe(true);
	expect(fn?.metadata.mappedArguments).toBe(false);
});

it("restores sloppy CommonJS dependencies from persisted loads", () => {
	const entry = join(directory, "cached-entry.mjs");
	const dependency = join(directory, "cached-dependency.cjs");
	writeFileSync(entry, `import ${JSON.stringify(dependency)};`);
	writeFileSync(
		dependency,
		`function duplicate(value, value) { return arguments; } module.exports = duplicate;`,
	);
	const cold = new ModuleParseCache();
	cold.usePersisted({}, {});
	buildModuleGraph(entry, { parseCache: cold });
	const persisted = cold.takePersistedChanges()!;
	const warm = new ModuleParseCache();
	warm.usePersisted(persisted.parses, persisted.loads);
	const graph = buildModuleGraph(entry, { parseCache: warm });
	expect(graph.modules.get(dependency)?.parsed.strict).toBe(false);
	expect(() => runSemanticAnalysisForGraph(graph)).not.toThrow();
});
