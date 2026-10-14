import { describe, expect, it } from "vitest";
import { resolveBuildConfig } from "../src/build-config.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { parseModule } from "../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../src/compiler/pipeline/compile-core.ts";
import {
	compilerProgramFactsFromConfig,
	programClosureCertificate,
	withProgramClosure,
} from "../src/compiler/shared/compiler-facts.ts";

function compile(consumer: string, closed = true, beforeConsume = "") {
	const entry = "/synchronous-callback.mjs";
	const facts = compilerProgramFactsFromConfig(
		resolveBuildConfig({ engine: { eval: false, realms: false, primordials: "locked" } }),
	);
	let report: CoreOptimizationReport | undefined;
	const source = `${consumer}
		globalThis.run = function run(values, seed) { const callback = value => value + seed; ${beforeConsume} return consume(values, callback); };`;
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(source, entry, parseModule(source)),
		{
			facts: closed
				? withProgramClosure(
						facts,
						programClosureCertificate({ kind: "whole-program", entry }, [], []),
					)
				: facts,
			coreInstrumentation: "full",
			coreVerification: "per-pass",
			afterCoreOptimization(_program, _context, result) {
				report = result;
			},
		},
	);
	return {
		image,
		applied: report!.transforms.appliedByKind["synchronous-callback-inline"] ?? 0,
		ordinaryInlines: report!.transforms.appliedByKind.inline ?? 0,
	};
}

const synchronous = `function consume(values, callback) { let sum = 0; for (let i = 0; i < values.length; i++) sum += callback(values[i]); return sum; }`;

describe("synchronous callback capture proof", () => {
	it("keeps existing direct callback uses outside the cloned consumer's admission", () => {
		expect(compile(synchronous, true, "callback(seed);").applied).toBeGreaterThan(0);
	});
	it("preserves exception handlers while admitting a synchronous iterator consumer", () => {
		const source = `function consume(values, callback) { let sum = 0; for (const value of values) sum += callback(value); return sum; }`;
		expect(compile(source).applied).toBeGreaterThan(0);
	});
	it("admits a synchronous loop consumer and removes its private callback capture", () => {
		const { image, applied, ordinaryInlines } = compile(synchronous);
		expect(applied).toBeGreaterThan(0);
		expect(ordinaryInlines).toBe(0);
		const run = image.runtime.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "run",
		)!;
		expect(run.capturedCount).toBe(0);
		expect(
			run.instructions.some((instruction) => instruction.opcode === "CREATE_FUNCTION"),
		).toBe(false);
	});

	it("reclaims capture storage retained only by an inlined callback's source frame", () => {
		const entry = "/rest-callback.mjs";
		const base = compilerProgramFactsFromConfig(
			resolveBuildConfig({ engine: { eval: false, realms: false } }),
		);
		const source = `function consume(values, callback) { for (const value of values) callback(value); }
		globalThis.run = function run(values, callback, ...args) { consume(values, value => callback(value, ...args)); };`;
		const image = compileSemanticProgramToProgramImage(
			analyzeSourceAndRunSemanticAnalysis(source, entry, parseModule(source)),
			{
				facts: withProgramClosure(
					base,
					programClosureCertificate({ kind: "whole-program", entry }, [], []),
				),
				coreVerification: "per-pass",
			},
		);
		const run = image.runtime.functions.find(
			(fn) =>
				String.fromCharCode(
					...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
				) === "run",
		)!;
		expect(run.capturedCount).toBe(0);
		expect(
			run.instructions.some(
				(op) =>
					op.opcode === "CREATE_FUNCTION" ||
					op.opcode === "CREATE_REST_ARGUMENTS" ||
					op.opcode === "STORE_CAPTURED",
			),
		).toBe(false);
		expect(
			run.instructions.filter((op) => op.opcode === "CALL_REST_ARGUMENTS"),
		).toHaveLength(1);
	});

	it.each([
		[
			"retention",
			`function consume(values, callback) { globalThis.saved = callback; for (let i = 0; i < values.length; i++) callback(values[i]); }`,
		],
		[
			"return",
			`function consume(values, callback) { for (let i = 0; i < values.length; i++) callback(values[i]); return callback; }`,
		],
		[
			"reflection",
			`function consume(values, callback) { for (let i = 0; i < values.length; i++) callback(values[i]); return callback.length; }`,
		],
		[
			"async",
			`async function consume(values, callback) { await 0; for (let i = 0; i < values.length; i++) callback(values[i]); }`,
		],
		[
			"generator",
			`function* consume(values, callback) { yield 0; for (let i = 0; i < values.length; i++) callback(values[i]); }`,
		],
	] as const)("rejects %s consumers", (_name, consumer) =>
		expect(compile(consumer).applied).toBe(0),
	);

	it("requires a source closure certificate", () =>
		expect(compile(synchronous, false).applied).toBe(0));

	it("retains every module-binding writer when the consumer can be replaced", () => {
		const source = `${synchronous}
		function retaining(values, callback) { globalThis.saved = callback; }
		globalThis.replace = () => { consume = retaining; };`;
		expect(compile(source).applied).toBe(0);
	});

	it("retains non-callable module-binding replacements", () => {
		expect(
			compile(`${synchronous} globalThis.clear = () => { consume = null; };`).applied,
		).toBe(0);
	});
});
