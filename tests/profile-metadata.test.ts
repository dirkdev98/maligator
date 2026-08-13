import { expect, test } from "vitest";
import { compileSemanticProgramToVmDefinition } from "../src/compile-core.ts";
import { parseScript } from "../src/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/semantic-analysis.ts";

function compile(source: string) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/src/profile-fixture.js",
		parseScript(source, { strict: true }),
	);
	return compileSemanticProgramToVmDefinition(semantic);
}

test("profile sites keep logical identity across unrelated line insertions", () => {
	const source = `function hot(object, key) { return object[key]; }\nhot(globalThis, "x");`;
	const shifted = compile(`\n\n${source}`);
	const original = compile(source);
	const originalSite = original.profileSites!.find((site) => site.operation === "property")!;
	const shiftedSite = shifted.profileSites!.find((site) => site.operation === "property")!;

	expect(shiftedSite.line).toBe(originalSite.line + 2);
	expect(shiftedSite.logicalId).toBe(originalSite.logicalId);
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
