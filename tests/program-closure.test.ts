import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ResolvedBuildConfig } from "../src/build-config.ts";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { ClosureEnvironment } from "../src/compiler/frontend/certify-closure.ts";
import { certifyProgramClosure } from "../src/compiler/frontend/certify-closure.ts";
import { buildModuleGraph } from "../src/compiler/frontend/module-graph.ts";
import { compileEntrypoint } from "../src/compiler/pipeline/compile-program.ts";
import type {
	ClosureOpeningKind,
	CompilerProgramFacts,
	ProgramClosureCertificate,
} from "../src/compiler/shared/compiler-facts.ts";
import {
	closureOpeningBreaksSourceClosure,
	compilerProgramFactsFromConfig,
	conservativeCompilerProgramFacts,
	unconfinedDynamicCode,
	unanalyzedProgramClosure,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";

const directories: Array<string> = [];

afterEach(() => {
	for (const directory of directories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

/** Write a module tree and return the absolute path of its `entry` file. */
function project(files: Record<string, string>, entry = "entry.mjs"): string {
	const directory = mkdtempSync(path.join(tmpdir(), "maligator-closure-"));
	directories.push(directory);
	for (const [name, source] of Object.entries(files)) {
		const file = path.join(directory, name);
		mkdirSync(path.dirname(file), { recursive: true });
		writeFileSync(file, source);
	}
	return path.join(directory, entry);
}

const wholeProgram: ClosureEnvironment = {
	relocatableArtifact: false,
	hostWireSplicing: false,
};

function certify(
	entry: string,
	options: {
		config?: ResolvedBuildConfig;
		environment?: ClosureEnvironment;
		entryPrelude?: { specifier: string; source: string };
		entryGoal?: "script";
	} = {},
): ProgramClosureCertificate {
	const config = options.config ?? resolveBuildConfig({ engine: { eval: false } });
	const graph = buildModuleGraph(entry, {
		buildConfig: config,
		...(options.entryPrelude === undefined ? {} : { entryPrelude: options.entryPrelude }),
		...(options.entryGoal === undefined ? {} : { entryGoal: options.entryGoal }),
	});
	return certifyProgramClosure(graph, config, options.environment ?? wholeProgram);
}

function openingKinds(certificate: ProgramClosureCertificate): Array<ClosureOpeningKind> {
	return certificate.openings.map((opening) => opening.kind);
}

describe("program closure certificate", () => {
	test("certifies a whole-program graph whose runtime cannot compile new source", () => {
		const certificate = certify(
			project({
				"entry.mjs": 'import { helper } from "./helper.mjs";\nhelper();\n',
				"helper.mjs": "export function helper() {}\n",
			}),
		);

		expect(certificate.scope.kind).toBe("whole-program");
		expect(certificate.openings).toEqual([]);
		expect(certificate.sourceClosure).toMatchObject({
			kind: "known",
			value: "closed",
			proof: {
				scope: { kind: "program" },
				dependencies: [{ kind: "world", fact: "source.closed" }],
			},
		});
	});

	test("treats a compile-checked eval policy as runtime source closure", () => {
		const certificate = certify(project({ "entry.mjs": "export const answer = 42;\n" }), {
			config: resolveBuildConfig({ engine: { eval: "compile-check" } }),
		});

		expect(certificate.openings).toEqual([]);
		expect(certificate.sourceClosure.kind).toBe("known");
	});

	test("keeps closure when run-time code can only run as global code", () => {
		const certificate = certify(
			project({
				"entry.mjs":
					'import { helper } from "./helper.mjs";\nhelper((0, eval)("1"), globalThis.eval("2"), Function("return 3"));\n',
				"helper.mjs": "export function helper() {}\n",
			}),
			{ config: resolveBuildConfig({ engine: { eval: true } }) },
		);

		expect(openingKinds(certificate)).toEqual(["global-dynamic-code"]);
		expect(certificate.sourceClosure.kind).toBe("known");
	});

	test("keeps closure for an ES module direct eval and names its module", () => {
		const entry = project({
			"entry.mjs": 'import { helper } from "./helper.mjs";\nhelper();\n',
			"helper.mjs":
				"let local = 1;\nexport function helper() {\n\treturn (eval)('local');\n}\n",
		});
		const certificate = certify(entry, {
			config: resolveBuildConfig({ engine: { eval: true } }),
		});

		expect(certificate.openings).toEqual([
			expect.objectContaining({ kind: "global-dynamic-code" }),
			expect.objectContaining({
				kind: "direct-eval",
				module: path.join(path.dirname(entry), "helper.mjs"),
			}),
		]);
		expect(certificate.sourceClosure.kind).toBe("known");
	});

	test("opens closure for a CommonJS direct eval", () => {
		const entry = project(
			{ "entry.cjs": "let local = 1;\nmodule.exports = eval('local');\n" },
			"entry.cjs",
		);
		const certificate = certify(entry, {
			config: resolveBuildConfig({ engine: { eval: true } }),
		});

		expect(certificate.openings).toEqual([
			expect.objectContaining({ kind: "dynamic-code", module: entry }),
		]);
		expect(certificate.sourceClosure).toEqual({
			kind: "unknown",
			reason: "eval-visible",
		});
	});

	test("opens closure when run-time code shares a script's global declarations", () => {
		const certificate = certify(
			project({ "entry.js": "let counter = 0;\n" }, "entry.js"),
			{
				config: resolveBuildConfig({ engine: { eval: true } }),
				entryGoal: "script",
			},
		);

		expect(openingKinds(certificate)).toEqual(["dynamic-code"]);
		expect(certificate.sourceClosure.kind).toBe("unknown");
	});

	test.each([
		["mutable primordials", { primordials: "mutable" }],
		["realms", { realms: true }],
	] as const)("opens closure for run-time code with %s", (_, engine) => {
		const certificate = certify(project({ "entry.mjs": "export const answer = 42;\n" }), {
			config: resolveBuildConfig({ engine: { eval: true, ...engine } }),
		});

		expect(openingKinds(certificate)).toEqual(["dynamic-code"]);
		expect(certificate.sourceClosure.kind).toBe("unknown");
	});

	test("opens closure when the executing host can splice further wire images", () => {
		const certificate = certify(project({ "entry.mjs": "export const answer = 42;\n" }), {
			environment: { relocatableArtifact: false, hostWireSplicing: true },
		});

		expect(openingKinds(certificate)).toEqual(["host-wire-splicing"]);
		expect(certificate.sourceClosure).toEqual({
			kind: "unknown",
			reason: "open-world-reachability",
		});
	});

	test("never claims whole-program closure for a relocatable fragment", () => {
		const entry = project({ "entry.mjs": "export const answer = 42;\n" });
		const certificate = certify(entry, {
			environment: { relocatableArtifact: true, hostWireSplicing: false },
		});

		expect(certificate.scope).toEqual({ kind: "fragment", entry });
		expect(openingKinds(certificate)).toEqual(["relocatable-artifact"]);
		expect(certificate.sourceClosure.kind).toBe("unknown");
	});

	test("enumerates the same roots and openings for the same graph", () => {
		const entry = project({
			"entry.mjs": 'import "./helper.mjs";\nimport("./lazy.mjs");\n',
			"helper.mjs": "export const helper = 1;\n",
			"lazy.mjs": "export const lazy = 2;\n",
		});

		expect(certify(entry)).toEqual(certify(entry));
	});
});

describe("closure root enumeration", () => {
	test("names the entry, its statically evaluated modules, and dynamic-only targets", () => {
		const entry = project({
			"entry.mjs": 'import "./helper.mjs";\nimport("./lazy.mjs");\n',
			"helper.mjs": "export const helper = 1;\n",
			"lazy.mjs": "export const lazy = 2;\n",
		});
		const directory = path.dirname(entry);
		const certificate = certify(entry);

		expect(certificate.roots).toEqual([
			{ kind: "entry-module", module: entry },
			{ kind: "static-module", module: path.join(directory, "helper.mjs") },
			{ kind: "dynamic-module", module: path.join(directory, "lazy.mjs") },
		]);
	});

	test("names a toolchain prelude as a virtual module root", () => {
		const entry = project({ "entry.mjs": "export const answer = 42;\n" });
		const certificate = certify(entry, {
			entryPrelude: {
				specifier: "maligator:prelude",
				source: "globalThis.ready = true;\n",
			},
		});

		expect(certificate.roots).toContainEqual({
			kind: "virtual-module",
			module: "maligator:prelude",
		});
	});

	test("names a resolved host built-in as a host module root", () => {
		const certificate = certify(
			project(
				{
					"entry.cjs": 'const path = require("node:path");\nmodule.exports = path;\n',
				},
				"entry.cjs",
			),
			{
				config: resolveBuildConfig({
					engine: { eval: false },
					surface: { node: true },
				}),
			},
		);

		expect(certificate.roots).toContainEqual({
			kind: "host-module",
			module: "node:path",
		});
		expect(certificate.sourceClosure.kind).toBe("known");
	});
});

describe("modelled module-loading openings", () => {
	test("records a computed dynamic import without losing source closure", () => {
		const certificate = certify(
			project({
				"entry.mjs": 'import("./" + globalThis.name + ".mjs");\nimport("./lazy.mjs");\n',
				"lazy.mjs": "export const lazy = 2;\n",
			}),
		);

		expect(openingKinds(certificate)).toEqual(["computed-module-specifier"]);
		expect(certificate.sourceClosure.kind).toBe("known");
	});

	test("records a computed require without losing source closure", () => {
		const certificate = certify(
			project(
				{ "entry.cjs": "module.exports = require(globalThis.name);\n" },
				"entry.cjs",
			),
		);

		expect(openingKinds(certificate)).toEqual(["computed-module-specifier"]);
		expect(certificate.sourceClosure.kind).toBe("known");
	});

	test("records an unresolvable literal dynamic import without losing source closure", () => {
		const certificate = certify(project({ "entry.mjs": 'import("./absent.mjs");\n' }));

		expect(openingKinds(certificate)).toEqual(["unresolved-module-target"]);
		expect(certificate.sourceClosure.kind).toBe("known");
	});

	test("records a catchable missing require without losing source closure", () => {
		const certificate = certify(
			project(
				{
					"entry.cjs":
						"let absent;\ntry {\n\tabsent = require('./absent.cjs');\n} catch {\n\tabsent = null;\n}\nmodule.exports = absent;\n",
				},
				"entry.cjs",
			),
		);

		expect(openingKinds(certificate)).toEqual(["unresolved-module-target"]);
		expect(certificate.sourceClosure.kind).toBe("known");
	});

	test("separates modelled loading edges from openings that admit unseen source", () => {
		const kinds: Record<ClosureOpeningKind, boolean> = {
			"not-analyzed": true,
			"dynamic-code": true,
			"global-dynamic-code": false,
			"direct-eval": false,
			"host-wire-splicing": true,
			"relocatable-artifact": true,
			"unresolved-runtime-load": true,
			"computed-module-specifier": false,
			"unresolved-module-target": false,
		};

		for (const [kind, breaks] of Object.entries(kinds)) {
			expect(closureOpeningBreaksSourceClosure(kind as ClosureOpeningKind)).toBe(breaks);
		}
	});
});

describe("closure without a module graph", () => {
	function expectUnanalyzed(facts: CompilerProgramFacts): void {
		expect(facts.closure.scope).toEqual({ kind: "unanalyzed" });
		expect(facts.closure.roots).toEqual([]);
		expect(openingKinds(facts.closure)).toEqual(["not-analyzed"]);
		expect(facts.closure.sourceClosure.kind).toBe("unknown");
	}

	test("keeps config-only facts open even when the runtime disables eval", () => {
		expectUnanalyzed(
			compilerProgramFactsFromConfig(resolveBuildConfig({ engine: { eval: false } })),
		);
	});

	test("keeps config-only facts open under a compile-checked eval policy", () => {
		expectUnanalyzed(
			compilerProgramFactsFromConfig(
				resolveBuildConfig({ engine: { eval: "compile-check" } }),
			),
		);
	});

	test("keeps compiler entry points without a build config open", () => {
		expectUnanalyzed(conservativeCompilerProgramFacts());
	});

	test("never certifies an unanalyzed certificate", () => {
		expect(unanalyzedProgramClosure("no graph").sourceClosure.kind).toBe("unknown");
	});
});

describe("world and source fact independence", () => {
	test("retains the primordial policy while source closure is open", () => {
		const facts = compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { eval: true, primordials: "locked" } }),
		);

		expect(facts.world.primordialPolicy).toBe("locked");
		expect(facts.closure.sourceClosure.kind).toBe("unknown");
	});
});

describe("compileEntrypoint closure wiring", () => {
	function factsFor(entry: string, config: ResolvedBuildConfig): CompilerProgramFacts {
		let observed: CompilerProgramFacts | undefined;
		compileEntrypoint(entry, {
			buildConfig: config,
			onProgramFacts: (facts) => {
				observed = facts;
			},
		});
		expect(observed).toBeDefined();
		return observed!;
	}

	test("carries a graph-derived certificate on the compiled program facts", () => {
		const entry = project({
			"entry.mjs": 'import { helper } from "./helper.mjs";\nhelper();\n',
			"helper.mjs": "export function helper() {}\n",
		});

		const facts = factsFor(entry, resolveBuildConfig({ engine: { eval: false } }));

		expect(facts.closure.scope).toEqual({ kind: "whole-program", entry });
		expect(facts.closure.roots.map((root) => root.kind)).toEqual([
			"entry-module",
			"static-module",
		]);
		expect(facts.closure.sourceClosure.kind).toBe("known");
	});

	test("carries a closed certificate when run-time eval can only run global code", () => {
		const entry = project({ "entry.mjs": "export const answer = 42;\n" });

		const facts = factsFor(entry, resolveBuildConfig({ engine: { eval: true } }));

		expect(openingKinds(facts.closure)).toEqual(["global-dynamic-code"]);
		expect(facts.closure.sourceClosure.kind).toBe("known");
	});

	test("carries a closed certificate when a direct eval can name only its module's bindings", () => {
		const entry = project({ "entry.mjs": "let answer = 42;\neval('answer');\n" });

		const facts = factsFor(entry, resolveBuildConfig({ engine: { eval: true } }));

		expect(openingKinds(facts.closure)).toEqual(["global-dynamic-code", "direct-eval"]);
		expect(facts.closure.sourceClosure.kind).toBe("known");
	});

	test("carries an open certificate when run-time eval can replace builtins", () => {
		const entry = project({ "entry.mjs": "let answer = 42;\neval('answer');\n" });

		const facts = factsFor(
			entry,
			resolveBuildConfig({ engine: { eval: true, primordials: "mutable" } }),
		);

		expect(openingKinds(facts.closure)).toEqual(["dynamic-code"]);
		expect(facts.closure.sourceClosure.kind).toBe("unknown");
	});
});

describe("dynamic code reach", () => {
	function factsWith(
		engine: Parameters<typeof resolveBuildConfig>[0]["engine"],
		source: string,
		entry = "entry.mjs",
	): CompilerProgramFacts {
		const config = resolveBuildConfig({ engine });
		return withProgramClosure(
			compilerProgramFactsFromConfig(config),
			certify(project({ [entry]: source }, entry), { config }),
		);
	}

	test("has no unconfined run-time code without a run-time compiler", () => {
		for (const evalPolicy of [false, "compile-check"] as const)
			expect(unconfinedDynamicCode(factsWith({ eval: evalPolicy }, "eval('x');\n"))).toBe(
				false,
			);
	});

	test("confines run-time code that can only run as global code", () => {
		expect(unconfinedDynamicCode(factsWith({ eval: true }, "Function('x');\n"))).toBe(
			false,
		);
	});

	test("confines an ES module direct eval to the bindings in its scope", () => {
		expect(unconfinedDynamicCode(factsWith({ eval: true }, "let x;\neval('x');\n"))).toBe(
			false,
		);
	});

	test("leaves a CommonJS direct eval unconfined", () => {
		expect(
			unconfinedDynamicCode(
				factsWith({ eval: true }, "let x;\neval('x');\n", "entry.cjs"),
			),
		).toBe(true);
	});

	test("leaves run-time code of an uncertified program unconfined", () => {
		expect(
			unconfinedDynamicCode(
				compilerProgramFactsFromConfig(resolveBuildConfig({ engine: { eval: true } })),
			),
		).toBe(true);
	});
});
