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
	function program(config = resolveBuildConfig({})) {
		return compileSemanticProgramToIr(
			analyzeSourceAndRunSemanticAnalysis(
				`function make(value) { return { value }; }\nmake(1);\n`,
				"summary.js",
			),
			{ facts: compilerProgramFactsFromConfig(config) },
		);
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
		expect(call.knownBuiltinCall?.identity.kind).toBe("known");
		expect(call.knownBuiltinCall?.sourceSite).toContain("builtin-call.js");
	});
});
