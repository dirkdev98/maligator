import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import type { CoreDirectEntryPlan } from "../src/compiler/core/core-ir-regions.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { analyzeEntrypoint } from "../src/compiler/pipeline/compile-program-common.ts";

const directory = mkdtempSync(join(tmpdir(), "mal-record-results-"));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// The loop keeps `scan` out of line, so its records cross a real call boundary.
const scanner = `
function scan(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	return { start, end };
}
`;

function compile(name: string, source: string) {
	const file = join(directory, `${name}.mjs`);
	writeFileSync(file, source);
	const analysis = analyzeEntrypoint(
		file,
		{ buildConfig: resolveBuildConfig({}), stripTypes: (text) => text },
		(_phase, run) => run(),
	);
	const core = optimizeSemanticProgramToCore(
		analysis.semantic,
		{ facts: analysis.facts },
		(_phase, run) => run(),
	);
	const named = (functionName: string) =>
		[...core.program.functionIds()].find(
			(id) =>
				String.fromCharCode(
					...(core.program.stringConstants[
						core.program.function(id).metadata.nameStringIndex
					] ?? []),
				) === functionName,
		)!;
	const recordEntry = (functionName: string): CoreDirectEntryPlan | undefined =>
		core.plan.directEntries.find(
			(entry) => entry.function === named(functionName) && entry.resultFields,
		);
	return { core, named, recordEntry };
}

describe("record result entries", () => {
	it("hands an out-of-line record to callers that only read its fields", () => {
		const { core, named, recordEntry } = compile(
			"selected",
			`${scanner}
function widths(text) {
	let total = 0;
	for (let index = 0; index < text.length; ) {
		const token = scan(text, index);
		total += token.end - token.start;
		index = token.end + 1;
	}
	return total;
}
function retain(text) {
	const tokens = [];
	for (let index = 0; index < text.length; ) {
		const token = scan(text, index);
		tokens.push(token);
		index = token.end + 1;
	}
	return tokens;
}
console.log(widths("ab cde f"), retain("ab cd").length);`,
		);
		const entry = recordEntry("scan");
		expect(entry?.resultFields?.allocations).toHaveLength(1);
		expect(entry!.callSites.map((site) => site.caller)).toEqual([named("widths")]);
		expect(entry!.callSites[0]!.resultLoads!.map((load) => load.field).sort()).toEqual([
			0, 1, 1,
		]);
		// No variant of a caller may route its record call to an ordinary-result entry.
		for (const caller of core.plan.directEntries.filter(
			(candidate) => candidate.function === named("widths"),
		))
			expect(
				caller.callOverrides?.some(
					(call) => call.instruction === entry!.callSites[0]!.instruction,
				) ?? false,
			).toBe(false);
	});

	it("keeps the object when the producer can expose it or returns other values", () => {
		const { recordEntry } = compile(
			"declined",
			`const seen = [];
function remembered(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	const token = { start, end };
	seen.push(token);
	return token;
}
function optional(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	return end === start ? null : { start, end };
}
function reordered(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	return end > start + 1 ? { start, end } : { end, start };
}
let total = 0;
for (let index = 0; index < 8; index++) {
	total += remembered("ab cd ef", index).end;
	total += optional("ab cd ef", index)?.end ?? 0;
	total += reordered("ab cd ef", index).end;
}
console.log(total, seen.length);`,
		);
		expect(recordEntry("remembered")).toBeUndefined();
		expect(recordEntry("optional")).toBeUndefined();
		expect(recordEntry("reordered")).toBeUndefined();
	});

	it("rejects a plan whose caller reads disagree with the current program", () => {
		const { core, recordEntry } = compile(
			"forged",
			`${scanner}
function last(text) {
	let end = 0;
	for (let index = 0; index < text.length; index = end + 1) end = scan(text, index).end;
	return end;
}
console.log(last("ab cd"));`,
		);
		const entry = recordEntry("scan")!;
		const site = entry.callSites[0]!;
		const forged = {
			...entry,
			callSites: [
				{
					...site,
					resultLoads: site.resultLoads!.map((load) => ({ ...load, field: 0 })),
				},
			],
		};
		expect(() =>
			verifyCoreOptimizationPlan(
				core.program,
				{
					...core.plan,
					directEntries: core.plan.directEntries.map((current) =>
						current === entry ? forged : current,
					),
				},
				core.context,
			),
		).toThrow(/record result proof|representation proof/);
	});
});
