import { expect, test } from "vitest";
import { parseScript } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	conservativeCompilerProgramFacts,
	knownFact,
} from "../src/compiler/shared/compiler-facts.ts";
import type { CompilerSiteFacts } from "../src/compiler/shared/compiler-facts.ts";
import { collectCompilerFactFlowReport } from "../src/compiler/target/fact-flow-report.ts";
import { createConservativeNativePlan } from "../src/compiler/target/program-image.ts";
import type { BytecodeInstruction } from "../src/compiler/target/runtime-image.ts";

function compile(source: string, profile = true) {
	const semantic = analyzeSourceAndRunSemanticAnalysis(
		source,
		"/project/src/fact-flow-fixture.js",
		parseScript(source, { strict: true }),
	);
	return compileSemanticProgramToProgramImage(semantic, { profile });
}

test("ordinary compilation does not collect fact flow", () => {
	const definition = compile("globalThis.result = globalThis.callback(1);", false);
	expect(definition.diagnostics.factFlow).toBeUndefined();
});

test("fact flow joins independent instruction maps by site, including target-specific sites", () => {
	const sites = new Map<string, CompilerSiteFacts>(
		["both", "vm", "native"].map((id) => [
			id,
			{
				id,
				functionId: "0",
				instruction: "call",
				callTargets: knownFact(
					{ functions: [1], anyScript: false, opaque: false },
					{
						scope: { kind: "program", entrypoint: "/contract.js" },
						dependencies: [],
						obligations: [],
						origin: "fact-flow-contract",
					},
				),
			},
		]),
	);
	const bothInstruction = {};
	const vmInstruction = {};
	const facts = { ...conservativeCompilerProgramFacts(), sites };
	facts.instructionSites.set(bothInstruction, sites.get("both")!);
	facts.instructionSites.set(vmInstruction, sites.get("vm")!);
	const call = (target: number): BytecodeInstruction => ({
		opcode: "CALL",
		dst: 0,
		callee: 1,
		thisValue: -1,
		argumentCount: 0,
		arguments: [],
		exactFunctionIndex: target,
	});
	const compiled = compile("globalThis.result = globalThis.callback();");
	const body = {
		...compiled.runtime.functions[0]!,
		instructions: [call(2), call(1), call(1), call(2)],
	};
	const native = {
		...createConservativeNativePlan([body]).functions[0]!,
		compilerSiteIds: [undefined, "native", undefined, "both"],
		instructions: [
			undefined,
			{ kind: "call" as const, directFunctionIndex: 1 },
			undefined,
			{ kind: "call" as const, directFunctionIndex: 1 },
		],
	};
	const report = collectCompilerFactFlowReport(
		facts,
		{ coreToExecution: [0, 1, 2], executionToCore: [] },
		{ ...compiled.runtime, functions: [body] },
		[
			new Map([
				[bothInstruction, 1],
				[vmInstruction, 2],
			]),
		],
		[native],
	);
	const outputs = report.entries.map(({ siteId, events }) => ({
		siteId,
		outputs: events
			.filter((event) => event.phase.endsWith("-output"))
			.map((event) => ({
				phase: event.phase,
				ip: event.instructionIndex,
				target: event.targetFunctionIndex,
			})),
	}));
	expect(outputs).toEqual([
		{
			siteId: "both",
			outputs: [
				{ phase: "runtime-output", ip: 1, target: 1 },
				{ phase: "native-output", ip: 3, target: 1 },
			],
		},
		{ siteId: "native", outputs: [{ phase: "native-output", ip: 1, target: 1 }] },
		{ siteId: "vm", outputs: [{ phase: "runtime-output", ip: 2, target: 1 }] },
	]);
});

test("fact flow does not publish residual targets without a selected consumer", () => {
	const definition = compile(`
		function recursive(value) {
			if (value <= 0) return 1;
			return value * recursive(value - 1);
		}
		globalThis.result = recursive(3) + globalThis.callback(1);
	`);
	const report = definition.diagnostics.factFlow!;
	expect(report.schema).toBe(1);
	expect(
		report.entries
			.flatMap(({ events }) => events)
			.some(
				(event) =>
					event.phase === "core-to-execution" &&
					event.disposition === "dropped" &&
					event.reason === "unsupported-consumer",
			),
	).toBe(false);
	expect(
		report.entries.every(({ events }) =>
			events.some(
				(event) =>
					event.phase === "core-optimization" &&
					event.artifact === "callee-target-set" &&
					event.disposition === "produced",
			),
		),
	).toBe(true);
	expect(report.summary.produced).toBe(report.entries.length);
});

test("fact flow records finite guarded target sets in both outputs", () => {
	const definition = compile(`
		function caller(useSecond, value) {
			function first(input) {
				if (input > 0) return input + 1;
				return input - 1;
			}
			function second(input) {
				if (input > 0) return input + 2;
				return input - 2;
			}
			const handler = useSecond ? second : first;
			return handler(value);
		}
		globalThis.result = caller(globalThis.useSecond, globalThis.value);
	`);
	const finite = definition.diagnostics.factFlow!.entries.find(
		({ functions, events }) =>
			functions.length === 2 &&
			events.some(
				(event) =>
					event.phase === "runtime-output" &&
					event.artifact === "guardedFunctionIndices" &&
					event.disposition === "consumed",
			),
	);

	expect(finite?.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				phase: "core-to-execution",
				disposition: "consumed",
				artifact: "guardedFunctionIndices",
			}),
			expect.objectContaining({
				phase: "native-output",
				disposition: "consumed",
				artifact: "guardedFunctionIndices",
			}),
		]),
	);
	expect(definition.diagnostics.factFlow!.summary.consumed).toBeGreaterThanOrEqual(3);
});

test("a singleton candidate with a non-callable alternative remains guarded", () => {
	const definition = compile(`
		function target(value) { ${"value += 1;".repeat(300)} return value; }
		const handler = globalThis.chooseTarget ? target : null;
		globalThis.result = handler(globalThis.value);
	`);
	const singleton = definition.diagnostics.factFlow!.entries.find(
		({ functions, events }) =>
			functions.length === 1 &&
			events.some(
				(event) =>
					event.phase === "native-output" && event.artifact === "guardedFunctionIndices",
			),
	);
	expect(singleton?.events).toEqual(
		expect.arrayContaining([
			expect.objectContaining({
				phase: "core-to-execution",
				artifact: "guardedFunctionIndices",
			}),
			expect.objectContaining({
				phase: "runtime-output",
				artifact: "guardedFunctionIndices",
			}),
		]),
	);
});

test("fact flow reports each target's own call coordinates after independent lowering", () => {
	const definition = compile(`
		function caller(flag, value) {
			function first(input) { if (input > 0) return input + 1; return input - 1; }
			function second(input) { if (input > 0) return input + 2; return input - 2; }
			const handler = flag ? first : second;
			const argument = flag ? value + 1 : value - 1;
			return handler(argument);
		}
		globalThis.result = caller(globalThis.flag, globalThis.value);
	`);
	const entries = definition.diagnostics.factFlow!.entries;
	for (const entry of entries) {
		const runtimeEvents = entry.events.filter(
			(event) => event.phase === "runtime-output",
		);
		const nativeEvents = entry.events.filter((event) => event.phase === "native-output");

		for (const event of [...runtimeEvents, ...nativeEvents]) {
			if (event.disposition === "dropped") continue;
			const targets = event.targetFunctionIndices ?? [event.targetFunctionIndex!];
			if (event.phase === "runtime-output") {
				const instruction =
					definition.runtime.functions[event.functionIndex!]!.instructions[
						event.instructionIndex!
					];
				expect(instruction?.opcode).toMatch(/^(CALL|CONSTRUCT)$/);
				if (instruction?.opcode !== "CALL" && instruction?.opcode !== "CONSTRUCT") {
					throw new Error("Runtime fact flow does not identify a call");
				}
				expect(
					instruction.exactFunctionIndex === undefined
						? instruction.opcode === "CALL"
							? instruction.guardedFunctionIndices
							: undefined
						: [instruction.exactFunctionIndex],
				).toEqual(targets);
			} else {
				const plan = definition.native.functions[event.functionIndex!]!;
				const instruction = plan.instructions[event.instructionIndex!];
				expect(plan.compilerSiteIds?.[event.instructionIndex!]).toBe(entry.siteId);
				if (instruction?.kind !== "call" && instruction?.kind !== "construct") {
					throw new Error("Native fact flow does not identify a call");
				}
				expect(
					instruction.directFunctionIndex === undefined
						? instruction.kind === "call"
							? instruction.guardedFunctionIndices
							: undefined
						: [instruction.directFunctionIndex],
				).toEqual(targets);
			}
		}
	}
});
