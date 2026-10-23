import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import { buildCoreControlFlow } from "../src/compiler/core/core-ir-control-flow.ts";
import { verifyCoreOptimizationPlan } from "../src/compiler/core/core-ir-region-validity.ts";
import type { CoreDirectEntryPlan } from "../src/compiler/core/core-ir-regions.ts";
import { analyzeCoreNativeEntry } from "../src/compiler/core/core-native-entry-analysis.ts";
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

function compile(
	name: string,
	source: string,
	config: Parameters<typeof resolveBuildConfig>[0] = {},
) {
	const file = join(directory, `${name}.mjs`);
	writeFileSync(file, source);
	const analysis = analyzeEntrypoint(
		file,
		{ buildConfig: resolveBuildConfig(config), stripTypes: (text) => text },
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
		// The verified copy keeps the record proofs that the representation proof compares.
		expect(() =>
			verifyCoreOptimizationPlan(core.program, core.plan, core.context),
		).not.toThrow();
		expect(entry!.callSites.map((site) => site.caller)).toEqual([named("widths")]);
		expect(
			entry!.callSites[0]!.recordUses!.loads.map((load) => load.field).sort(),
		).toEqual([0, 1, 1]);
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

	it("forwards a producer's record through a helper that returns it", () => {
		const { core, named, recordEntry } = compile(
			"forwarded",
			`${scanner}
function word(text, start) {
	let index = start;
	while (index < text.length && text.charCodeAt(index) === 32) index++;
	return scan(text, index);
}
function widths(text) {
	let total = 0;
	for (let index = 0; index < text.length; ) {
		const token = word(text, index);
		total += token.end - token.start;
		index = token.end + 1;
	}
	return total;
}
function direct(text) {
	return scan(text, 0).end;
}
console.log(widths("ab  cde f"), direct("ab"));`,
		);
		const forwarder = recordEntry("word")!;
		const producer = recordEntry("scan")!;
		expect(forwarder.resultFields!.forwards!.map((forward) => forward.target)).toEqual([
			named("scan"),
		]);
		expect(forwarder.callOverrides).toEqual([
			{
				instruction: forwarder.resultFields!.forwards![0]!.instruction,
				target: named("scan"),
				entryId: producer.id,
			},
		]);
		// Only a forward may route a call to the caller-storage ABI.
		const stray = core.plan.directEntries.find(
			(entry) => entry.function === named("widths") && entry.resultFields === undefined,
		);
		if (stray !== undefined) {
			const site = [...core.program.function(named("widths")).instructionIds()].find(
				(instruction) =>
					core.program.function(named("widths")).instructionOpcodeName(instruction) ===
					"call",
			)!;
			const callOverrides = [
				{ instruction: site, target: named("scan"), entryId: producer.id },
			];
			const variant = analyzeCoreNativeEntry(
				core.program.function(stray.function),
				buildCoreControlFlow(core.program, stray.function, { exceptions: true }),
				stray.parameterRepresentations,
				undefined,
				stray.callSites,
				undefined,
				undefined,
				callOverrides,
			);
			const forged = { ...stray, ...variant, callOverrides };
			expect(() =>
				verifyCoreOptimizationPlan(
					core.program,
					{
						...core.plan,
						directEntries: core.plan.directEntries.map((current) =>
							current === stray ? forged : current,
						),
					},
					core.context,
				),
			).toThrow(/invalid call override/);
		}
	});

	const decoder = `
function decode(operand) {
	for (let guard = 0; guard < 1; guard++) if (operand === -1000) throw new Error("bad");
	if (operand >= 0) return { kind: "register", register: operand };
	if (operand === -1) return { kind: "undefined" };
	return { kind: "string", index: -operand };
}
function count(operands, registers) {
	let valid = 0;
	for (const operand of operands) {
		const decoded = decode(operand);
		if (decoded.kind !== "register" || decoded.register < registers) valid++;
	}
	return valid;
}
console.log(count([1, -1, -4, 9], 4));`;

	it("returns literals with different keys when locked primordials prove the missing keys", () => {
		const { core, recordEntry } = compile("union", decoder);
		const entry = recordEntry("decode")!;
		const keys = entry.resultFields!.keys.map((key) =>
			core.program.stringConstantText(key),
		);
		expect(keys).toEqual(["kind", "register", "index"]);
		expect(entry.resultFields!.shapes).toEqual([[0, 1], [0], [0, 2]]);
		expect(entry.callSites).toHaveLength(1);
	});

	it("keeps literals with different keys on the heap when primordials can change", () => {
		const { recordEntry } = compile("union-mutable", decoder, {
			engine: { primordials: "mutable" },
		});
		expect(recordEntry("decode")).toBeUndefined();
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
		const callSites = [
			{
				...site,
				recordUses: {
					...site.recordUses!,
					loads: site.recordUses!.loads.map((load) => ({ ...load, field: 0 })),
				},
			},
		];
		// A current representation proof isolates the record proof as the one that fails.
		const variant = analyzeCoreNativeEntry(
			core.program.function(entry.function),
			buildCoreControlFlow(core.program, entry.function, { exceptions: true }),
			entry.parameterRepresentations,
			undefined,
			callSites,
			undefined,
			undefined,
			undefined,
			entry.resultFields,
		);
		const forged = { ...entry, ...variant, callSites };
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
		).toThrow(/record result proof/);
	});
});
