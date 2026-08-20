import { expect, test } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToVmDefinition } from "../src/compiler/pipeline/compile-core.ts";
import { compilerProgramFactsFromConfig } from "../src/compiler/shared/compiler-facts.ts";
import { emitVmDefinition } from "../src/compiler/target/emit-vm.ts";
import { matchProfileSites } from "../src/compiler/target/profile-metadata.ts";

function compile(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/src/profile-fixture.js",
		parseScript(source, { strict: true }),
	);
	return compileSemanticProgramToVmDefinition(semantic, {
		facts: compilerProgramFactsFromConfig(resolveBuildConfig({})),
		profile: true,
	});
}

test("ordinary compilation skips profile-only metadata", () => {
	const source = `function hot(object, key) { return object[key]; }`;
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/src/ordinary-fixture.js",
		parseScript(source, { strict: true }),
	);
	const definition = compileSemanticProgramToVmDefinition(semantic);

	expect(definition.profileSites).toBeUndefined();
	expect(definition.profileRemarks).toBeUndefined();
	expect(definition.optimizationTrace).toBeUndefined();
});

test("profile sites keep logical identity across unrelated line insertions", () => {
	const source = `function hot(object, key) { return object[key]; }\nhot(globalThis, "x");`;
	const shifted = compile(`\n\n${source}`);
	const original = compile(source);
	const originalSite = original.profileSites!.find(
		(site) => site.operation === "property",
	)!;
	const shiftedSite = shifted.profileSites!.find(
		(site) => site.operation === "property",
	)!;

	expect(shiftedSite.line).toBe(originalSite.line + 2);
	expect(shiftedSite.logicalId).toBe(originalSite.logicalId);
	const matches = matchProfileSites(original.profileSites!, shifted.profileSites!);
	expect(matches.logical).toBeGreaterThan(0);
	expect(matches.coverage).toBeGreaterThan(0.9);
});

test("profile metadata gives instructions dense sites and structured remarks", () => {
	const definition = compile(
		`function hot(object, key) { object.fixed = {}; return object[key]; } hot(globalThis, "x");`,
	);
	emitVmDefinition(definition);
	const sites = definition.profileSites!;
	const remarks = definition.profileRemarks!;

	expect(sites.length).toBeGreaterThan(0);
	expect(definition.optimizationTrace?.length).toBeGreaterThan(0);
	const trace = definition.optimizationTrace!;
	expect(
		trace.every(({ before, after, delta }) => {
			for (const metric of [
				"instructions",
				"blocks",
				"values",
				"facts",
				"regions",
				"allocationSites",
				"dynamicCalls",
				"boxedOperations",
				"propertyHelpers",
				"worldGuards",
				"safepoints",
			] as const) {
				if (after[metric] - before[metric] !== delta[metric]) return false;
			}
			return true;
		}),
	).toBe(true);
	expect(trace.some(({ delta }) => delta.instructions < 0 && delta.values < 0)).toBe(
		true,
	);
	expect(sites.map((site) => site.id)).toEqual(sites.map((_, index) => index));
	expect(
		definition.functions
			.flatMap((fn) => fn.profileSiteIds ?? [])
			.every((id) => id < sites.length),
	).toBe(true);
	expect(remarks).toContainEqual(
		expect.objectContaining({
			phase: "native-backend",
			operation: "property",
			code: "property.native",
			outcome: "applied",
		}),
	);
	expect(
		remarks.find(
			(remark) =>
				remark.operation === "property" && remark.details?.opcode === "LOAD_PROPERTY",
		),
	).toBeDefined();
	expect(remarks).toContainEqual(
		expect.objectContaining({ operation: "allocation", code: "allocation.heap" }),
	);
});

test("same-position operations retain distinct optimized instance identities", () => {
	const definition = compile(
		`function hot(object) { object.left = {}; object.right = {}; return object; } hot(globalThis);`,
	);
	const sites = definition.profileSites!.filter(
		(site) => site.operation === "property" || site.operation === "allocation",
	);
	expect(new Set(sites.map((site) => site.id)).size).toBe(sites.length);
	expect(new Set(sites.map((site) => site.instanceId)).size).toBe(sites.length);
	expect(sites.every((site) => site.originId !== "" && site.regionId !== "")).toBe(true);
});

test("every residual allocation, call, property, and boxing site has a remark", () => {
	const definition = compile(`
		function hot(value, escape) {
			const object = { value };
			if (escape) return object;
			array.push(object.value + 1);
			return object.value;
		}
		globalThis.keep = hot;
		globalThis.math = Math;
	`);
	const relevant = definition.profileSites!.filter((site) =>
		["allocation", "call", "property", "boxing"].includes(site.operation),
	);
	const remarked = new Set(definition.profileRemarks!.map(({ siteId }) => siteId));
	expect(relevant.length).toBeGreaterThan(0);
	expect(relevant.every(({ id }) => remarked.has(id))).toBe(true);
	const knownBuiltin = definition.profileRemarks!.find(
		(remark) => remark.code === "optimization.applied.known-builtin",
	);
	expect(knownBuiltin?.facts?.dependencies).toEqual(["world:primordials.locked"]);
	expect(definition.profileRemarks).toContainEqual(
		expect.objectContaining({ code: "optimization.applied.immutable-binding" }),
	);
	expect(definition.profileRemarks).toContainEqual(
		expect.objectContaining({
			code: "optimization.applied.partial-escape-materialization",
		}),
	);
	expect(definition.optimizationTrace!.some((event) => event.delta.worldGuards > 0)).toBe(
		true,
	);
});

test("profile remarks retain applied substitutions after the call disappears", () => {
	const definition = compile(`
		function outer(value) {
			function addOne(input) { return input + 1; }
			return addOne(value);
		}
		globalThis.keep = outer;
	`);
	const remark = definition.profileRemarks!.find(
		(candidate) => candidate.code === "optimization.applied.inline",
	)!;
	const site = definition.profileSites![remark.siteId]!;

	expect(remark).toMatchObject({ phase: "optimization", outcome: "applied" });
	expect(site).toMatchObject({ operation: "call", file: "profile-fixture.js" });
	expect(site.line).toBe(4);
});

test("profile remarks explain substitution barriers at the original call site", () => {
	const closureDefinition = compile(`
		function outer(value) {
			function returnsClosure(input) {
				function inner() { return 1; }
				if (input) return inner;
				return 0;
			}
			return returnsClosure(value);
		}
		globalThis.keep = outer;
	`);
	const exceptionDefinition = compile(`
		function outer(value) {
			function guarded(input) {
				try { if (input) throw input; }
				catch (error) { return error; }
				return 0;
			}
			return guarded(value);
		}
		globalThis.keep = outer;
	`);
	const escapeDefinition = compile(`
		function run(count) {
			function partial(value, escape) {
				const object = { value };
				if (escape) return object;
				return typeof object === "object" ? object.value : 0;
			}
			let total = 0;
			for (let index = 0; index < count; index++) {
				const result = partial(index, index === count - 1);
				total += typeof result === "object" ? result.value : result;
			}
			return total;
		}
		globalThis.keep = run;
	`);

	for (const [definition, reason] of [
		[closureDefinition, "inner-closure"],
		[exceptionDefinition, "exception-region"],
		[escapeDefinition, "escape-cost-barrier"],
	] as const) {
		const code = `optimization.declined.${reason}`;
		const decisions = definition.profileRemarks!.filter((remark) => remark.code === code);
		expect(decisions).toHaveLength(1);
		expect(decisions[0]).toMatchObject({
			phase: "optimization",
			outcome: "declined",
			reason,
		});
		expect(definition.profileSites![decisions[0]!.siteId]!.operation).toBe("call");
	}
});

test("cross-build profile matching reports duplicate structural sites as ambiguous", () => {
	const site = compile(
		`function hot(object, key) { return object[key]; }`,
	).profileSites!.find((candidate) => candidate.operation === "property")!;
	const duplicate = { ...site, id: site.id + 1 };
	const matches = matchProfileSites([site, duplicate], [site, duplicate]);
	expect(matches).toMatchObject({ exact: 0, logical: 0, ambiguous: 2, unmatched: 0 });
});
