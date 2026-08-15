import { expect, test } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { emitVmDefinition } from "../src/emit-vm.ts";
import { parseScript } from "../src/parser.ts";
import { matchProfileSites } from "../src/profile-metadata.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function compile(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/src/profile-fixture.js",
		parseScript(source, { strict: true }),
	);
	return compileSemanticProgramToVmDefinition(semantic, { profile: true });
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

test("cross-build profile matching reports duplicate structural sites as ambiguous", () => {
	const site = compile(
		`function hot(object, key) { return object[key]; }`,
	).profileSites!.find((candidate) => candidate.operation === "property")!;
	const duplicate = { ...site, id: site.id + 1 };
	const matches = matchProfileSites([site, duplicate], [site, duplicate]);
	expect(matches).toMatchObject({ exact: 0, logical: 0, ambiguous: 2, unmatched: 0 });
});
