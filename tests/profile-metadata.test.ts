import { expect, test } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";
import { matchProfileSites } from "../src/profile-metadata.ts";

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
	const originalSite = original.profileSites!.find((site) => site.operation === "property")!;
	const shiftedSite = shifted.profileSites!.find((site) => site.operation === "property")!;

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
	const sites = definition.profileSites!;
	const remarks = definition.profileRemarks!;

	expect(sites.length).toBeGreaterThan(0);
	expect(sites.map((site) => site.id)).toEqual(sites.map((_, index) => index));
	expect(
		definition.functions.flatMap((fn) => fn.profileSiteIds ?? []).every((id) => id < sites.length),
	).toBe(true);
	expect(remarks).toContainEqual(
		expect.objectContaining({ code: "property.dynamic-load", outcome: "retained" }),
	);
	expect(remarks).toContainEqual(
		expect.objectContaining({ code: "property.static-store", outcome: "applied" }),
	);
});

test("cross-build profile matching reports duplicate structural sites as ambiguous", () => {
	const site = compile(`function hot(object, key) { return object[key]; }`).profileSites!.find(
		(candidate) => candidate.operation === "property",
	)!;
	const duplicate = { ...site, id: site.id + 1 };
	const matches = matchProfileSites([site, duplicate], [site, duplicate]);
	expect(matches).toMatchObject({ exact: 0, logical: 0, ambiguous: 2, unmatched: 0 });
});
