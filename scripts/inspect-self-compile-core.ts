import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreCompilation } from "../src/compiler/core/core-compilation.ts";
import type { CoreOptimizationPlan } from "../src/compiler/core/core-ir-regions.ts";
import type { CoreFunctionId } from "../src/compiler/core/core-ir.ts";
import type { CoreOptimizationReport } from "../src/compiler/core/core-optimization-report.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { analyzeEntrypoint } from "../src/compiler/pipeline/compile-program-common.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import {
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

function option(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index < 0 ? undefined : process.argv[index + 1];
}

function requiredPositiveInteger(name: string): number | undefined {
	const raw = option(name);
	if (raw === undefined && !process.argv.includes(name)) return undefined;
	const value = Number(raw);
	if (!Number.isSafeInteger(value) || value < 0) {
		throw new Error(`${name} requires a non-negative integer`);
	}
	return value;
}

function functionName(compilation: CoreCompilation, functionId: CoreFunctionId): string {
	const fn = compilation.program.function(functionId);
	return (
		String.fromCharCode(
			...(compilation.program.stringConstants[fn.metadata.nameStringIndex] ?? []),
		) || "<anonymous>"
	);
}

const root = mkdtempSync(path.join(os.tmpdir(), "mal-inspect-self-compile-core-"));
try {
	const sourceRoot = path.join(root, "source");
	const fullTarget = prepareSelfCompileSource(sourceRoot);
	const entry = option("--entry");
	if (
		process.argv.includes("--entry") &&
		(entry === undefined ||
			path.isAbsolute(entry) ||
			entry.split(path.sep).includes(".."))
	) {
		throw new Error("--entry requires a source-root-relative path");
	}
	const target = process.argv.includes("--full")
		? fullTarget
		: entry === undefined
			? path.join(sourceRoot, "src/compiler/core/core-ir-shape-provenance.ts")
			: path.join(sourceRoot, entry);
	const phases: Record<string, number> = {};
	const runPhase = <T>(phase: string, run: () => T): T => {
		const startedAt = Date.now();
		try {
			return run();
		} finally {
			phases[phase] = (phases[phase] ?? 0) + Date.now() - startedAt;
		}
	};
	const { semantic, facts } = analyzeEntrypoint(
		target,
		{ buildConfig: SELF_COMPILE_CONFIG, stripTypes: (source) => source },
		runPhase,
	);
	let report: CoreOptimizationReport | undefined;
	let plan: CoreOptimizationPlan | undefined;
	const compilation = optimizeSemanticProgramToCore(
		semantic,
		{
			facts,
			coreInstrumentation: "full",
			afterCoreOptimization(_program, _context, optimizationReport, optimizationPlan) {
				report = optimizationReport;
				plan = optimizationPlan;
			},
		},
		runPhase,
	);
	if (report === undefined || plan === undefined) {
		throw new Error("Core optimization did not publish its report and plan");
	}
	const native = process.argv.includes("--native")
		? runPhase("lower native", () => lowerCoreCompilationToExecution(compilation))
		: undefined;
	const filter = option("--filter");
	if (process.argv.includes("--filter") && filter === undefined) {
		throw new Error("--filter requires a source-path substring");
	}
	const line = requiredPositiveInteger("--line");
	const requestedFunction = requiredPositiveInteger("--function");
	const requestedFunctions = (option("--functions") ?? "")
		.split(",")
		.filter(Boolean)
		.map(Number);
	if (requestedFunctions.some((value) => !Number.isSafeInteger(value) || value < 0)) {
		throw new Error("--functions requires comma-separated non-negative integers");
	}
	const instructionSites = [...compilation.program.functionIds()].flatMap(
		(functionId) => {
			const fn = compilation.program.function(functionId);
			return [...fn.blockIds()].flatMap((block) =>
				[...fn.bodyInstructionIds(block)].flatMap((instruction) => {
					const positionId = fn.instructionSourcePosition(instruction);
					const position =
						positionId === undefined
							? undefined
							: compilation.program.sourcePositions[positionId];
					const sourcePath = path.relative(sourceRoot, fn.metadata.sourcePath);
					if (filter !== undefined && !sourcePath.includes(filter)) return [];
					if (line !== undefined && Math.abs((position?.line ?? 0) - line) > 2) return [];
					return [
						{
							function: functionId,
							block,
							instruction,
							opcode: fn.instructionOpcodeName(instruction),
							operands: fn.instructionOperands(instruction),
							results: fn.instructionResults(instruction),
							attributes: fn.instructionAttributes(instruction),
							sourcePath,
							line: position?.line ?? 0,
							column: position?.column ?? 0,
						},
					];
				}),
			);
		},
	);
	const selectedFunctions = [
		...(requestedFunction === undefined ? [] : [requestedFunction]),
		...requestedFunctions,
	].map((value) => value as CoreFunctionId);
	const liveFunctions = new Set(compilation.program.functionIds());
	for (const functionId of selectedFunctions) {
		if (!liveFunctions.has(functionId)) {
			throw new Error(`unknown function index ${functionId}`);
		}
	}
	const functionDescriptors = selectedFunctions.map((functionId) => {
		const fn = compilation.program.function(functionId);
		return {
			function: functionId,
			name: functionName(compilation, functionId),
			sourcePath: path.relative(sourceRoot, fn.metadata.sourcePath),
			parameters: fn.parameters.length,
			blocks: [...fn.blockIds()].length,
			instructions: [...fn.instructionIds()].length,
			versions: fn.versions,
		};
	});
	const result = {
		workload: process.argv.includes("--full")
			? "full"
			: entry === undefined
				? "quick"
				: `entry:${entry}`,
		phases,
		report,
		plan: {
			version: plan.version.key,
			liveFunctions: plan.liveFunctions.length,
			directEntries: plan.directEntries,
			specializations: plan.specializations,
			statistics: plan.statistics,
		},
		realization:
			native === undefined
				? undefined
				: {
						functions: native.functions.length,
						directEntries: native.functions.reduce(
							(count, fn) => count + fn.directEntries.length,
							0,
						),
						specializations: native.functions.reduce(
							(count, fn) => count + fn.specializations.length,
							0,
						),
					},
		...(filter === undefined ? {} : { instructions: instructionSites }),
		...(functionDescriptors.length === 0 ? {} : { functions: functionDescriptors }),
	};
	const snapshot = option("--snapshot");
	if (process.argv.includes("--snapshot") && snapshot === undefined) {
		throw new Error("--snapshot requires an output path");
	}
	if (snapshot !== undefined) writeFileSync(snapshot, `${JSON.stringify(result)}\n`);
	console.log(JSON.stringify(result, undefined, 2));
} finally {
	rmSync(root, { recursive: true, force: true });
}
