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
	unanalyzedProgramClosure,
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
	} = {},
): ProgramClosureCertificate {
	const config = options.config ?? resolveBuildConfig({ engine: { eval: false } });
	const graph = buildModuleGraph(entry, {
		buildConfig: config,
		...(options.entryPrelude === undefined ? {} : { entryPrelude: options.entryPrelude }),
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

	test("opens closure when the runtime can compile new source", () => {
		const certificate = certify(project({ "entry.mjs": "export const answer = 42;\n" }), {
			config: resolveBuildConfig({ engine: { eval: true } }),
		});

		expect(openingKinds(certificate)).toEqual(["dynamic-code"]);
		expect(certificate.sourceClosure).toEqual({
			kind: "unknown",
			reason: "eval-visible",
		});
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

describe("authority closure independence", () => {
	test("retains authority closure while source closure is open", () => {
		const facts = compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { eval: true } }),
		);

		expect(facts.world.authorityClosure).toBe("closed");
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

	test("carries an open certificate when the build enables runtime eval", () => {
		const entry = project({ "entry.mjs": "export const answer = 42;\n" });

		const facts = factsFor(entry, resolveBuildConfig({ engine: { eval: true } }));

		expect(openingKinds(facts.closure)).toEqual(["dynamic-code"]);
		expect(facts.closure.sourceClosure.kind).toBe("unknown");
	});
});
