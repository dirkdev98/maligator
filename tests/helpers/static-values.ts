import { resolveBuildConfig } from "../../src/build-config.ts";
import type { CoreOptimizationReport } from "../../src/compiler/core/core-optimization-report.ts";
import { parseScript } from "../../src/compiler/frontend/parser.ts";
import { analyzeSourceAndRunSemanticAnalysis } from "../../src/compiler/frontend/semantic-analysis.ts";
import { compileSemanticProgramToProgramImage } from "../../src/compiler/pipeline/compile-core.ts";
import { literalPrototypeMethods } from "../../src/compiler/shared/builtin-registry.ts";
import { compilerProgramFactsFromConfig } from "../../src/compiler/shared/compiler-facts.ts";
import type { ExecutionProgram } from "../../src/compiler/target/execution-ir.ts";
import { emitCompiledFunction } from "../../src/compiler/target/render-native-c.ts";
import { coreFunctionNamed, coreOperations } from "./core-inspection.ts";
import type { CoreOperationInspection } from "./core-inspection.ts";

export interface StaticValueOptions {
	locked?: boolean;
	intl?: boolean;
	profile?: boolean;
	counters?: boolean;
	script?: boolean;
}

export function inspectStaticValueFunction(
	source: string,
	name: string,
	options: StaticValueOptions = {},
) {
	return inspectStaticValueFunctions(source, [name], options).get(name)!;
}

export function inspectStaticValueFunctions(
	source: string,
	names: ReadonlyArray<string>,
	options: StaticValueOptions = {},
) {
	const cores = new Map<string, ReadonlyArray<CoreOperationInspection>>();
	let execution: ExecutionProgram | undefined;
	let coreReport: CoreOptimizationReport | undefined;
	const phases: Record<string, number> = {};
	const started = performance.now();
	const image = compileSemanticProgramToProgramImage(
		analyzeSourceAndRunSemanticAnalysis(
			source,
			options.script ? "static-values.js" : "static-values.mjs",
			options.script ? parseScript(source, { strict: false }) : undefined,
		),
		{
			facts: compilerProgramFactsFromConfig(
				resolveBuildConfig({
					engine: {
						primordials: options.locked === false ? "mutable" : "locked",
						...(options.intl === undefined ? {} : { intl: { enabled: options.intl } }),
					},
				}),
			),
			profile: options.profile,
			coreInstrumentation: options.counters ? "counters" : "off",
			afterCoreOptimization(program, _context, report) {
				coreReport = report;
				for (const name of names) {
					const fn = coreFunctionNamed(program, name);
					if (fn === undefined) throw new Error(`Missing Core function ${name}`);
					cores.set(name, coreOperations(fn));
				}
			},
			runPhase(phase, run) {
				const start = performance.now();
				const value = run();
				phases[phase] = performance.now() - start;
				if (phase === "core to execution") execution = value as ExecutionProgram;
				return value;
			},
		},
	);
	const compileMs = performance.now() - started;
	return new Map(
		names.map((name) => {
			const core = cores.get(name)!;
			const index = image.runtime.functions.findIndex(
				(fn) =>
					String.fromCharCode(
						...(image.runtime.stringConstants[fn.nameStringIndex] ?? []),
					) === name,
			);
			if (index < 0) throw new Error(`Missing runtime function ${name}`);
			const fn = image.runtime.functions[index]!;
			const native = image.native.functions[index]!;
			const c = emitCompiledFunction(
				fn,
				native,
				index,
				"",
				false,
				"static",
				new Set(),
				[],
				new Map(),
				false,
				new Set(),
				image.runtime.stringConstants,
			);
			if (c === null) throw new Error(`Missing native function ${name}`);
			const count = (...opcodes: Array<string>) =>
				fn.instructions.filter((instruction) => opcodes.includes(instruction.opcode))
					.length;
			return [
				name,
				{
					image,
					core,
					execution: execution?.functions[index],
					c,
					fn,
					native,
					phases,
					compileMs,
					coreReport,
					structure: {
						operations: fn.instructions.flatMap((instruction) =>
							instruction.opcode === "CALL_KNOWN"
								? literalPrototypeMethods
										.filter((method) => method.id === instruction.operation)
										.slice(0, 1)
								: [],
						),
						allocations: count(
							"CREATE_ARRAY",
							"CREATE_OBJECT",
							"CREATE_OBJECT_SHAPED",
							"INSTANTIATE_LITERAL_TEMPLATE",
						),
						pooledMaterializations: fn.instructions.filter(
							(instruction) =>
								instruction.opcode === "INSTANTIATE_LITERAL_TEMPLATE" &&
								instruction.cacheSlot !== undefined,
						).length,
						genericLookups: count("LOAD_PROPERTY", "LOAD_PROPERTY_STATIC"),
						genericCalls: count("CALL"),
						coercions: count("TO_NUMBER", "TO_NUMERIC", "TO_STRING", "TO_PROPERTY_KEY"),
						representations: native.registerRepresentations,
					},
				},
			] as const;
		}),
	);
}

/**
 * Compile independent exported functions together and release each result when inspected.
 * Keep matrices in a describe per profile so shuffled tests release one profile before the next.
 */
export function staticValueCases<T extends ReadonlyArray<string>>(
	entries: ReadonlyArray<T>,
	source: (entry: T, name: string) => string,
	options: StaticValueOptions = {},
) {
	const batchSize = 32;
	return Array.from(
		{ length: Math.ceil(entries.length / batchSize) },
		(_, batchIndex) => {
			const batch = entries.slice(batchIndex * batchSize, (batchIndex + 1) * batchSize);
			const names = batch.map((_, index) => `probe_${index}`);
			let pending: ReturnType<typeof inspectStaticValueFunctions> | undefined;
			return batch.map(
				(entry, index) =>
					[
						entry[0]!,
						entry,
						() => {
							pending ??= inspectStaticValueFunctions(
								batch.map((entry, index) => source(entry, names[index]!)).join("\n"),
								names,
								options,
							);
							const name = names[index]!;
							const output = pending.get(name);
							if (output === undefined) {
								// Repeats compile one fixture without retaining its consumed batch image.
								return inspectStaticValueFunction(source(entry, name), name, options);
							}
							// Release the shared image when the final shuffled case consumes its result.
							pending.delete(name);
							return output;
						},
					] as const,
			);
		},
	).flat();
}
