import { readFileSync } from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import {
	generatePrimordialRegistryInclude,
	primordialGlobalBindings,
	primordialObjectPolicy,
	validateBuiltinRegistry,
} from "../src/builtin-registry.ts";
import {
	joinFacts,
	knownFact,
	sourceSiteId,
	unknownFact,
	worldFactsFromConfig,
} from "../src/compiler-facts.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler-facts.ts";
import {
	compilerSummaryCacheIdentity,
	ensureCompilerSummaries,
} from "../src/compiler-summaries.ts";
import { annotateDirectArrayPushSites } from "../src/inline.ts";
import { compileSemanticProgramToIr } from "../src/ir.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

describe("compiler fact contracts", () => {
	const proof = {
		scope: { kind: "function" as const, id: 1 },
		dependencies: [{ kind: "world" as const, fact: "primordials.locked" as const }],
		obligations: [],
		origin: "test",
	};

	it("keeps an equal fact and exposes the predecessor that loses one", () => {
		expect(joinFacts(knownFact("Math.abs", proof), knownFact("Math.abs", proof))).toEqual(
			{
				fact: knownFact("Math.abs", proof),
			},
		);
		expect(
			joinFacts(knownFact("Math.abs", proof), unknownFact("unknown-call-target")),
		).toEqual({
			fact: unknownFact("unknown-call-target"),
			lostBy: "right",
		});
	});

	it("reports conflicting payloads and scopes explicitly", () => {
		expect(
			joinFacts(knownFact("Math.abs", proof), knownFact("Math.floor", proof)),
		).toEqual({
			fact: unknownFact("conflicting-control-flow"),
			lostBy: "conflict",
		});
	});

	it("derives authority and source closure independently", () => {
		const closed = worldFactsFromConfig(resolveBuildConfig({}));
		expect(closed.primordialPolicy).toBe("locked");
		expect(closed.authorityClosure).toBe("closed");
		expect(closed.sourceClosure.kind).toBe("known");

		const evalWorld = worldFactsFromConfig(
			resolveBuildConfig({ engine: { eval: true, primordials: "locked" } }),
		);
		expect(evalWorld.authorityClosure).toBe("closed");
		expect(evalWorld.sourceClosure).toEqual(unknownFact("eval-visible"));
	});

	it("uses stable logical source-site identities", () => {
		expect(sourceSiteId("src/a b.ts", 3, 7, "call")).toBe(
			sourceSiteId("src/a b.ts", 3, 7, "call"),
		);
		expect(sourceSiteId("src/a b.ts", 3, 7, "call")).not.toBe(
			sourceSiteId("src/a b.ts", 3, 7, "property"),
		);
	});

	it("represents locked invariants separately from mutable epoch facts", () => {
		const locked = compilerProgramFactsFromConfig(resolveBuildConfig({}));
		const mutable = compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { primordials: "mutable" } }),
		);
		expect(locked.protectors.get("watched-methods")).toMatchObject({
			kind: "known",
			proof: { dependencies: [{ kind: "world", fact: "primordials.locked" }] },
		});
		expect(locked.protectors.get("object-shapes")).toMatchObject({
			kind: "known",
			proof: { dependencies: [{ kind: "epoch", family: "object-shapes" }] },
		});
		expect(mutable.protectors.get("watched-methods")).toMatchObject({
			kind: "known",
			proof: { dependencies: [{ kind: "epoch", family: "watched-methods" }] },
		});
		expect(locked.builtinIdentities.get("Math.floor")).toMatchObject({
			kind: "known",
			proof: { dependencies: [{ kind: "world", fact: "primordials.locked" }] },
		});
		expect(mutable.builtinIdentities.get("Math.floor")).toMatchObject({
			kind: "known",
			proof: { dependencies: [{ kind: "epoch", family: "watched-methods" }] },
		});
		expect(locked.immutableGlobalBindings.get("Math")?.kind).toBe("known");
		expect(mutable.immutableGlobalBindings.get("Math")).toEqual(
			unknownFact("invalidatable-epoch"),
		);
	});
});

describe("builtin and primordial registry", () => {
	it("has unique identities and an explicit host exclusion", () => {
		expect(() => validateBuiltinRegistry()).not.toThrow();
		expect(primordialGlobalBindings.map(({ name }) => name)).not.toContain("console");
		expect(primordialObjectPolicy.excludedIntrinsics).toContain("MAL_INTRINSIC_CONSOLE");
	});

	it("matches the checked-in C include", () => {
		const generated = readFileSync(
			path.resolve("runtime/src/generated/primordial_registry.inc"),
			"utf8",
		);
		expect(generated).toBe(generatePrimordialRegistryInclude());
	});
});

describe("shared effect and reachability summaries", () => {
	const defaultSource = `function make(value) { return { value }; }\nmake(1);\n`;
	function program(config = resolveBuildConfig({}), source = defaultSource) {
		return compileSemanticProgramToIr(
			analyzeSourceAndRunSemanticAnalysis(source, "summary.js"),
			{ facts: compilerProgramFactsFromConfig(config) },
		);
	}

	function attachHostGraph(
		ir: ReturnType<typeof program>,
		hostExports: ReadonlyArray<string>,
	): void {
		const file = ir.semantic.files[0]!;
		ir.semantic.graph = {
			entry: file.path,
			nodeEnabled: true,
			modules: new Map([
				[
					file.path,
					{
						path: file.path,
						goal: "script" as const,
						source: file.contents,
						parsed: file,
						dependencies: [],
					},
				],
				[
					"node:fixture",
					{
						path: "node:fixture",
						goal: "module" as const,
						source: "",
						parsed: file,
						dependencies: [],
						host: {
							id: "node:fixture",
							named: hostExports,
							hasDefault: false,
							installer: "mal_host_install_node_fixture",
						},
					},
				],
			]),
			evaluationOrder: ["node:fixture", file.path],
			cycles: [],
		};
	}

	it("adapts the existing escape fixed point into shared function/module facts", () => {
		const ir = program();
		const summaries = ensureCompilerSummaries(ir);
		expect(summaries.functionEffects.size).toBe(ir.functions.length);
		expect(summaries.moduleEffects.get("summary.js")?.functions).toHaveLength(
			ir.functions.length,
		);
		expect(ir.facts.functionEffects).toBe(summaries.functionEffects);
	});

	it("records conservative property, call, and transitive effect families", () => {
		const ir = compileSemanticProgramToIr(
			analyzeSourceAndRunSemanticAnalysis(
				`function read(value) { return value.name; }\nread(globalThis);\n`,
				"effects.js",
			),
			{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
		);
		const effects = [...ensureCompilerSummaries(ir).functionEffects.values()].flatMap(
			(summary) => summary.effects,
		);
		expect(effects).toContain("property-access");
		expect(effects).toContain("read-prototype");
		expect(effects).toContain("unknown-call");
	});

	it("caches by source, compiler analysis version, and relevant world facts", () => {
		const first = program();
		const equivalent = program(
			resolveBuildConfig({ engine: { intl: { enabled: true } } }),
		);
		expect(compilerSummaryCacheIdentity(equivalent)).toBe(
			compilerSummaryCacheIdentity(first),
		);
		expect(ensureCompilerSummaries(equivalent)).toBe(ensureCompilerSummaries(first));

		const mutable = program(resolveBuildConfig({ engine: { primordials: "mutable" } }));
		expect(compilerSummaryCacheIdentity(mutable)).not.toBe(
			compilerSummaryCacheIdentity(first),
		);
		expect(
			compilerSummaryCacheIdentity(
				program(resolveBuildConfig({ engine: { eval: true } })),
			),
		).not.toBe(compilerSummaryCacheIdentity(first));
		expect(
			compilerSummaryCacheIdentity(
				program(resolveBuildConfig({ engine: { realms: true } })),
			),
		).not.toBe(compilerSummaryCacheIdentity(first));
		expect(
			compilerSummaryCacheIdentity(program(undefined, `${defaultSource}\n0;`)),
		).not.toBe(compilerSummaryCacheIdentity(first));
	});

	it("invalidates summaries when module or host graph identity changes", () => {
		const first = program();
		const changedHost = program();
		attachHostGraph(first, ["read"]);
		attachHostGraph(changedHost, ["read", "write"]);
		expect(compilerSummaryCacheIdentity(changedHost)).not.toBe(
			compilerSummaryCacheIdentity(first),
		);

		const additionalModule = program();
		additionalModule.semantic.files.push(
			...analyzeSourceAndRunSemanticAnalysis("const value = 1;", "dep.mjs").files,
		);
		expect(compilerSummaryCacheIdentity(additionalModule)).not.toBe(
			compilerSummaryCacheIdentity(program()),
		);
	});
});

describe("canonical builtin-call IR facts", () => {
	it("records the proof target and logical source site without changing legacy lowering", () => {
		const ir = compileSemanticProgramToIr(
			analyzeSourceAndRunSemanticAnalysis(
				`function append(array) { return array.push(1); }\nappend([]);\n`,
				"builtin-call.js",
			),
			{ facts: compilerProgramFactsFromConfig(resolveBuildConfig({})) },
		);
		expect(annotateDirectArrayPushSites(ir)).toBeGreaterThan(0);
		const call = ir.functions
			.flatMap(({ blocks }) => blocks)
			.flatMap(({ instructions }) => instructions)
			.find(
				(instruction) =>
					instruction.type === "call" &&
					instruction.knownBuiltinCall?.operation === "Array.prototype.push",
			);
		expect(call?.type).toBe("call");
		if (call?.type !== "call") throw new Error("missing canonical builtin call");
		expect(call.directArrayPush).toBe(true);
		expect(call.knownBuiltinCall?.identity).toMatchObject({
			kind: "known",
			proof: { dependencies: [{ kind: "world", fact: "primordials.locked" }] },
		});
		expect(call.knownBuiltinCall?.sourceSite).toContain("builtin-call.js");
	});

	it("keeps existing mutable lowering backed by the watched-method epoch", () => {
		const ir = compileSemanticProgramToIr(
			analyzeSourceAndRunSemanticAnalysis(`array.push(1);`, "mutable-call.js"),
			{
				facts: compilerProgramFactsFromConfig(
					resolveBuildConfig({ engine: { primordials: "mutable" } }),
				),
			},
		);
		expect(annotateDirectArrayPushSites(ir)).toBeGreaterThan(0);
		const call = ir.functions
			.flatMap(({ blocks }) => blocks)
			.flatMap(({ instructions }) => instructions)
			.find(
				(instruction) =>
					instruction.type === "call" && instruction.directArrayPush === true,
			);
		expect(call?.type).toBe("call");
		if (call?.type !== "call") throw new Error("missing mutable builtin call");
		expect(call.knownBuiltinCall?.identity).toMatchObject({
			kind: "known",
			proof: { dependencies: [{ kind: "epoch", family: "watched-methods" }] },
		});
	});
});
