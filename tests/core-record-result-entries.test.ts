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

	it("keeps the object when the producer can expose it or reorders its keys", () => {
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
function reordered(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	return end > start + 1 ? { start, end } : { end, start };
}
let total = 0;
for (let index = 0; index < 8; index++) {
	total += remembered("ab cd ef", index).end;
	total += reordered("ab cd ef", index).end;
}
console.log(total, seen.length);`,
		);
		expect(recordEntry("remembered")).toBeUndefined();
		expect(recordEntry("reordered")).toBeUndefined();
	});

	it("lets a producer return other values next to its record", () => {
		const { recordEntry } = compile(
			"escaped",
			`const empty = { start: 0, end: 0 };
function optional(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	if (end === start) return empty;
	if (end - start > 4) return;
	return { start, end };
}
function literalOnly(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	return { start, end };
}
let total = 0;
for (let index = 0; index < 8; index++) {
	try {
		total += optional("ab cd efghij", index).end;
	} catch {
		total++;
	}
	total += literalOnly("ab cd ef", index).end;
}
console.log(total);`,
		);
		expect(recordEntry("optional")?.resultFields?.escapes).toBe(true);
		expect(recordEntry("literalOnly")?.resultFields).toBeDefined();
		expect(recordEntry("literalOnly")?.resultFields?.escapes).toBeUndefined();
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
				core.program,
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
			core.program,
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

	it("rejects a plan that hides a producer's other returns", () => {
		const { core, recordEntry } = compile(
			"hidden",
			`function scan(text, start) {
	let end = start;
	while (end < text.length && text.charCodeAt(end) !== 32) end++;
	if (end === start) return;
	return { start, end };
}
function last(text) {
	let end = 0;
	for (let index = 0; index < text.length; index = end + 1) end = scan(text, index).end;
	return end;
}
console.log(last("ab cd"));`,
		);
		const entry = recordEntry("scan")!;
		const { escapes: _escapes, ...resultFields } = entry.resultFields!;
		const variant = analyzeCoreNativeEntry(
			core.program,
			buildCoreControlFlow(core.program, entry.function, { exceptions: true }),
			entry.parameterRepresentations,
			undefined,
			entry.callSites,
			undefined,
			undefined,
			undefined,
			resultFields,
		);
		const forged = { ...entry, ...variant, resultFields };
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

	it("hands a caller's record to a callee that reads and writes its fields", () => {
		const { core, named, recordEntry } = compile(
			"passed",
			`${scanner}
function stretch(span, by) {
	for (let step = 0; step < by; step++) span.end++;
	return span.end - span.start;
}
function stretched(text) {
	let total = 0;
	for (let index = 0; index < text.length; ) {
		const token = scan(text, index);
		total += stretch(token, 2) + token.end;
		index = token.end - 1;
	}
	return total;
}
console.log(stretched("ab cd ef"));`,
		);
		const parameters = core.plan.directEntries.find(
			(entry) => entry.function === named("stretch") && entry.recordParameters,
		)!.recordParameters!;
		expect(parameters).toHaveLength(1);
		expect(parameters[0]!.index).toBe(0);
		expect(parameters[0]!.keys).toEqual(recordEntry("scan")!.resultFields!.keys);
		expect(parameters[0]!.uses.stores.length).toBeGreaterThan(0);
		expect(parameters[0]!.uses.observers).toEqual([]);
		const site = recordEntry("scan")!.callSites.find(
			(candidate) => candidate.caller === named("stretched"),
		)!;
		expect(site.recordUses!.observers).toEqual([]);
		expect(site.recordUses!.passes).toEqual([
			expect.objectContaining({ argument: 0, target: named("stretch") }),
		]);
	});

	it("keeps the object for callees that can reach the record otherwise", () => {
		const { core, named, recordEntry } = compile(
			"unpassed",
			`${scanner}
function viaArguments(span) {
	let width = 0;
	for (let index = span.start; index < span.end; index++) width++;
	return width + arguments[0].end;
}
async function later(span) {
	await null;
	return span.end;
}
function callers(text) {
	let total = 0;
	for (let index = 0; index < text.length; ) {
		const token = scan(text, index);
		total += viaArguments(token);
		later(token);
		index = token.end + 1;
	}
	return total;
}
console.log(callers("ab cd ef"));`,
		);
		for (const callee of ["viaArguments", "later"])
			expect(
				core.plan.directEntries.some(
					(entry) => entry.function === named(callee) && entry.recordParameters,
				),
				callee,
			).toBe(false);
		const site = recordEntry("scan")?.callSites.find(
			(candidate) => candidate.caller === named("callers"),
		);
		expect(site?.recordUses?.passes).toBeUndefined();
	});

	it("rejects plans that misstate a record parameter or a pass target", () => {
		const { core, named, recordEntry } = compile(
			"forged-parameter",
			`${scanner}
function width(span) {
	let width = 0;
	for (let index = span.start; index < span.end; index++) width++;
	return width;
}
function widths(text) {
	let total = 0;
	for (let index = 0; index < text.length; ) {
		const token = scan(text, index);
		total += width(token);
		index = token.end + 1;
	}
	return total;
}
function spans(text) {
	let total = 0;
	for (let index = 0; index < text.length; ) {
		const token = scan(text, index);
		total += token.end - token.start;
		index = token.end + 1;
	}
	return total;
}
console.log(widths("ab cd ef"), spans("ab cd ef"));`,
		);
		const verify = (directEntries: ReadonlyArray<CoreDirectEntryPlan>) => () =>
			verifyCoreOptimizationPlan(
				core.program,
				{ ...core.plan, directEntries },
				core.context,
			);
		const callee = core.plan.directEntries.find(
			(entry) => entry.function === named("width") && entry.recordParameters,
		)!;
		const parameter = callee.recordParameters![0]!;
		const recordParameters = Object.freeze([
			Object.freeze({
				...parameter,
				uses: {
					...parameter.uses,
					loads: parameter.uses.loads.map((load) => ({ ...load, field: 0 })),
				},
			}),
		]);
		// A current representation proof isolates the record proof as the one that fails.
		const variant = analyzeCoreNativeEntry(
			core.program,
			buildCoreControlFlow(core.program, callee.function, { exceptions: true }),
			callee.parameterRepresentations,
			undefined,
			callee.callSites,
			undefined,
			undefined,
			undefined,
			undefined,
			recordParameters,
		);
		const forgedCallee = { ...callee, ...variant, recordParameters };
		expect(
			verify(
				core.plan.directEntries.map((entry) => (entry === callee ? forgedCallee : entry)),
			),
		).toThrow(/record parameter proof/);

		const producer = recordEntry("scan")!;
		const callSites = producer.callSites.map((site) =>
			site.recordUses?.passes === undefined
				? site
				: {
						...site,
						recordUses: {
							...site.recordUses,
							passes: site.recordUses.passes.map((pass) => ({
								...pass,
								target: named("widths"),
							})),
						},
					},
		);
		const producerVariant = analyzeCoreNativeEntry(
			core.program,
			buildCoreControlFlow(core.program, producer.function, { exceptions: true }),
			producer.parameterRepresentations,
			undefined,
			callSites,
			undefined,
			undefined,
			undefined,
			producer.resultFields,
		);
		const forgedProducer = { ...producer, ...producerVariant, callSites };
		expect(
			verify(
				core.plan.directEntries.map((entry) =>
					entry === producer ? forgedProducer : entry,
				),
			),
		).toThrow(/record result proof/);

		// Without the record call that keeps it in storage, the callee has no record to read.
		const unsupplied = producer.callSites.filter(
			(site) => site.recordUses?.passes === undefined,
		);
		const unsuppliedVariant = analyzeCoreNativeEntry(
			core.program,
			buildCoreControlFlow(core.program, producer.function, { exceptions: true }),
			producer.parameterRepresentations,
			undefined,
			unsupplied,
			undefined,
			undefined,
			undefined,
			producer.resultFields,
		);
		expect(unsupplied.length).toBeGreaterThan(0);
		expect(
			verify(
				core.plan.directEntries.map((entry) =>
					entry === producer
						? { ...producer, ...unsuppliedVariant, callSites: unsupplied }
						: entry,
				),
			),
		).toThrow(/record parameter proof/);
	});

	it("keeps an object literal a callee takes as a record parameter in caller storage", () => {
		const { core, named } = compile(
			"literal",
			`const failures = [];
function reject(message, context) {
	failures.push(context);
	throw new RangeError(message);
}
const KNOWN = { move: 2 };
function shapeOf(type, context) {
	const shape = KNOWN[type];
	if (shape !== undefined) return shape;
	for (let step = 0; step < 1; step++) if (type === "bad") reject("unknown", context);
	context.opcode = type.toUpperCase();
	return type.length;
}
function shapes(types) {
	let total = 0;
	for (let index = 0; index < types.length; index++) {
		const context = { index, opcode: types[index] };
		total += shapeOf(types[index], context);
		if (context.opcode !== types[index]) total += 100;
	}
	return total;
}
console.log(shapes(["move", "add"]));`,
		);
		const entry = core.plan.directEntries.find(
			(candidate) =>
				candidate.function === named("shapeOf") && candidate.recordParameters,
		)!;
		expect(entry.recordParameters!.map((parameter) => parameter.index)).toEqual([1]);
		const site = entry.callSites[0]!;
		expect(site.recordObjects?.map((object) => object.argument)).toEqual([1]);
		const object = site.recordObjects![0]!;
		expect(object.uses.loads.length).toBeGreaterThan(0);

		const callSites = [
			{
				...site,
				recordObjects: [
					{
						...object,
						uses: {
							...object.uses,
							loads: object.uses.loads.map((load) => ({ ...load, field: 0 })),
						},
					},
				],
			},
		];
		const variant = analyzeCoreNativeEntry(
			core.program,
			buildCoreControlFlow(core.program, entry.function, { exceptions: true }),
			entry.parameterRepresentations,
			undefined,
			callSites,
			undefined,
			undefined,
			undefined,
			undefined,
			entry.recordParameters,
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
		).toThrow(/record object proof/);
	});
});
