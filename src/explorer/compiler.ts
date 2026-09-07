import type { CoreCompilation } from "../compiler/core/core-compilation.ts";
import { lowerSemanticProgramToCore } from "../compiler/core/core-frontend.ts";
import { verifyCoreOptimizationPlan } from "../compiler/core/core-ir-region-validity.ts";
import type { CoreOptimizationPlan } from "../compiler/core/core-ir-regions.ts";
import { formatCoreProgram } from "../compiler/core/core-ir.ts";
import type { CoreProgram } from "../compiler/core/core-ir.ts";
import type { CoreOptimizationReport } from "../compiler/core/core-optimization-report.ts";
import { buildCoreSpecializationRecipeTable } from "../compiler/core/core-specialization-recipes.ts";
import { optimizeCore } from "../compiler/core/optimize.ts";
import { runSemanticAnalysisForGraph } from "../compiler/frontend/analyze-module-graph.ts";
import { validateSemanticBuildPolicy } from "../compiler/frontend/build-policy.ts";
import { certifyProgramClosure } from "../compiler/frontend/certify-closure.ts";
import { stripCompactTypes } from "../compiler/frontend/compact-type-strip.ts";
import { traverseEstree } from "../compiler/frontend/estree-traversal.ts";
import type { ModuleGraph } from "../compiler/frontend/module-graph.ts";
import { parseModule } from "../compiler/frontend/parser.ts";
import {
	compilerProgramFactsFromConfig,
	withProgramClosure,
} from "../compiler/shared/compiler-facts.ts";
import { emitProgramImage } from "../compiler/target/emit-program-image.ts";
import type {
	ExecutionFunction,
	ExecutionProgram,
} from "../compiler/target/execution-ir.ts";
import { lowerCoreCompilationToExecution } from "../compiler/target/lower-native-execution.ts";
import { lowerExecutionToProgramImage } from "../compiler/target/lower-native-program-image.ts";
import { serializeRuntimeImage } from "../compiler/target/program-image-codec.ts";
import type {
	NativeFunctionPlan,
	ProgramImage,
} from "../compiler/target/program-image.ts";
import type { BytecodeFunction, RuntimeImage } from "../compiler/target/runtime-image.ts";
import {
	EXPLORER_LIMITS,
	explorerSourcePath,
	normalizeExplorerLanguage,
	explorerBuildConfig,
	normalizeExplorerConfig,
	utf8ByteLength,
} from "./config.ts";
import type { ModeId } from "./samples.ts";

function decodeString(units: ReadonlyArray<number>): string {
	return String.fromCharCode(...units);
}

export function stableValue(value: unknown): unknown {
	if (typeof value === "bigint") return `${value}n`;
	if (value instanceof Map) {
		return [...value.entries()]
			.map(([key, entry]) => [stableValue(key), stableValue(entry)])
			.sort(([left], [right]) => String(left).localeCompare(String(right)));
	}
	if (value instanceof Set) {
		return [...value]
			.map(stableValue)
			.sort((left, right) => String(left).localeCompare(String(right)));
	}
	if (Array.isArray(value)) return value.map(stableValue);
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(
			Object.entries(value)
				.filter(([, entry]) => entry !== undefined)
				.sort(([left], [right]) => left.localeCompare(right))
				.map(([key, entry]) => [key, stableValue(entry)]),
		);
	}
	return value;
}

export function stableJson(value: unknown): string {
	return JSON.stringify(stableValue(value), null, 2);
}

function formatConstantPools(program: CoreProgram): string {
	const strings = program.stringConstants.map(
		(units, index) =>
			`  [${index}] ${JSON.stringify(decodeString(units))} · UTF-16 ${units
				.map((unit) => `0x${unit.toString(16).padStart(4, "0")}`)
				.join(" ")}`,
	);
	const bigints = program.bigintConstants.map((value, index) => `  [${index}] ${value}n`);
	return [
		`CoreProgram · ${program.functionCapacity} functions · ${program.globalCount} globals`,
		"",
		`stringConstants (${strings.length})`,
		...(strings.length === 0 ? ["  (empty)"] : strings),
		"",
		`bigintConstants (${bigints.length})`,
		...(bigints.length === 0 ? ["  (empty)"] : bigints),
		"",
		`literalTemplateData (${program.literalTemplateData.length} words)`,
		`  ${program.literalTemplateData.join(" ") || "(empty)"}`,
	].join("\n");
}

function formatCore(program: CoreProgram): string {
	return [formatConstantPools(program), "", formatCoreProgram(program)].join("\n");
}

function functionName(image: RuntimeImage, fn: BytecodeFunction): string {
	return decodeString(image.stringConstants[fn.nameStringIndex] ?? []) || "<anonymous>";
}

function sourcePosition(
	image: RuntimeImage,
	fn: BytecodeFunction,
	instructionIndex: number,
): string {
	const positionId = fn.positions[instructionIndex];
	if (positionId === undefined || positionId < 0) return "-";
	const position = image.sourcePositions[positionId];
	if (position === undefined) return `position ${positionId}`;
	const file = image.files[fn.fileIndex] ?? image.entrypointPath;
	return `${file}:${position.line}:${position.column + 1}`;
}

function formatRuntimeImage(image: RuntimeImage): string {
	const lines = [
		`MALW decoded RuntimeImage · ${image.functions.length} functions · ${image.globalCount} globals`,
		`entrypoint ${image.entrypointPath}`,
		"",
		"stringConstants · length-prefixed UTF-16 code units",
	];
	for (const [index, units] of image.stringConstants.entries()) {
		lines.push(
			`  [${index}] ${JSON.stringify(decodeString(units))}`,
			`      units ${units.map((unit) => unit.toString(16).padStart(4, "0")).join(" ") || "(empty)"}`,
		);
	}
	lines.push("", "bigintConstants · signed 128-bit values (low u64, high u64)");
	const mask = (1n << 64n) - 1n;
	for (const [index, value] of image.bigintConstants.entries()) {
		lines.push(
			`  [${index}] ${value}n · lo 0x${(value & mask).toString(16).padStart(16, "0")} · hi 0x${((value >> 64n) & mask).toString(16).padStart(16, "0")}`,
		);
	}
	if (image.bigintConstants.length === 0) lines.push("  (empty)");
	lines.push(
		"",
		`literalTemplateData (${image.literalTemplateData.length} u32 words)`,
		`  ${image.literalTemplateData.join(" ") || "(empty)"}`,
		"",
	);
	for (const [functionIndex, fn] of image.functions.entries()) {
		lines.push(
			`function ${functionIndex} ${JSON.stringify(functionName(image, fn))}`,
			`  kind ${fn.isAsync && fn.isGenerator ? "async-generator" : fn.isAsync ? "async" : fn.isGenerator ? "generator" : "normal"} · params ${fn.parameterCount} · registers ${fn.registerCount} · captures ${fn.capturedCount}`,
			`  strict ${fn.strict} · arguments ${fn.needsArguments} · handlers ${fn.handlers.length} · safepoints ${fn.gcSafepoints?.length ?? 0}`,
		);
		for (const [instructionIndex, instruction] of fn.instructions.entries()) {
			lines.push(
				`  ${String(instructionIndex).padStart(4, "0")}  ${instruction.opcode.padEnd(38)} ${stableJson(
					instruction,
				)
					.replace(/^\{\n|\n\}$/g, "")
					.replace(/\n/g, " ")
					.replace(/\s+/g, " ")
					.trim()}  @ ${sourcePosition(image, fn, instructionIndex)}`,
			);
		}
		if (fn.gcSafepoints !== undefined && fn.gcSafepoints.length > 0) {
			lines.push(
				"  gcSafepoints",
				...fn.gcSafepoints.map((entry) => `    ${stableJson(entry).replace(/\n/g, " ")}`),
			);
		}
		if (fn.handlers.length > 0) {
			lines.push(
				"  handlers",
				...fn.handlers.map((entry) => `    ${stableJson(entry).replace(/\n/g, " ")}`),
			);
		}
		lines.push("");
	}
	lines.push(
		"precompiledLiteralShapes",
		stableJson(image.precompiledLiteralShapes),
		"hostInstalls",
		stableJson(image.hostInstalls),
	);
	return lines.join("\n");
}

function formatExecutionFunction(fn: ExecutionFunction): string {
	const lines = [
		`execution function ${fn.functionIndex} · ${fn.sourcePath}`,
		`  params ${fn.parameterCount} · registers ${fn.registerCount} · captures ${fn.capturedCount}`,
		`  representations ${fn.registerRepresentations.map((representation, register) => `%${register}:${representation}`).join(" ")}`,
		`  specializations ${fn.specializations.length} · direct entries ${fn.directEntries.length}`,
	];
	for (const [blockIndex, block] of fn.blocks.entries()) {
		lines.push(`  block ${blockIndex}`);
		for (const instruction of block.instructions) {
			lines.push(
				`    ${stableJson(instruction).replace(/\n/g, " ").replace(/\s+/g, " ")}`,
			);
		}
	}
	lines.push("  parallel copies", stableJson(fn.parallelCopies));
	lines.push("  gc safepoints", stableJson(fn.gc.safepoints));
	return lines.join("\n");
}

function formatNativePlan(fn: NativeFunctionPlan): string {
	return [
		`native plan function ${fn.functionIndex} · ${fn.mode}`,
		`  representations ${fn.registerRepresentations.map((representation, register) => `%${register}:${representation}`).join(" ")}`,
		"  direct entries",
		stableJson(fn.directEntries),
		"  gc safepoints",
		stableJson(fn.gc.safepoints),
		"  instruction decisions (index-preserving; null means generic lowering)",
		...fn.instructions.map(
			(instruction, index) =>
				`    ${String(index).padStart(4, "0")} ${instruction === undefined ? "generic" : stableJson(instruction).replace(/\n/g, " ").replace(/\s+/g, " ")}`,
		),
		"  specializations",
		stableJson(fn.specializations),
	].join("\n");
}

function formatTarget(program: ExecutionProgram, image: ProgramImage): string {
	return [
		"ExecutionProgram · allocated backend-neutral terminal",
		"",
		...program.functions.map(formatExecutionFunction),
		"",
		"NativePlan · native-only decisions consumed by C emission",
		`semantic protectors\n${stableJson(image.native.semanticProtectors)}`,
		...image.native.functions.map(formatNativePlan),
	].join("\n\n");
}

function wireHex(bytes: Uint8Array): string {
	const lines: Array<string> = [];
	for (let offset = 0; offset < bytes.length; offset += 16) {
		const row = bytes.slice(offset, offset + 16);
		const hex = [...row].map((byte) => byte.toString(16).padStart(2, "0")).join(" ");
		const ascii = [...row]
			.map((byte) => (byte >= 0x20 && byte < 0x7f ? String.fromCharCode(byte) : "."))
			.join("");
		lines.push(
			`${offset.toString(16).padStart(8, "0")}  ${hex.padEnd(47)}  |${ascii.padEnd(16)}|`,
		);
	}
	return lines.join("\n");
}

function summarizeRuntime(image: RuntimeImage, wire: Uint8Array, c: string) {
	return {
		functions: image.functions.length,
		instructions: image.functions.reduce((sum, fn) => sum + fn.instructions.length, 0),
		strings: image.stringConstants.length,
		stringCodeUnits: image.stringConstants.reduce((sum, units) => sum + units.length, 0),
		bigints: image.bigintConstants.length,
		globals: image.globalCount,
		handlers: image.functions.reduce((sum, fn) => sum + fn.handlers.length, 0),
		safepoints: image.functions.reduce(
			(sum, fn) => sum + (fn.gcSafepoints?.length ?? 0),
			0,
		),
		wireBytes: wire.length,
		cCodeUnits: c.length,
		cLines: c.split("\n").length,
	};
}

export function compileExplorerCore(
	source: string,
	settings: unknown = {},
	inputLanguage: unknown = "javascript",
) {
	if (utf8ByteLength(source) > EXPLORER_LIMITS.sourceBytes)
		throw new RangeError("Source exceeds the 64 KiB UTF-8 limit");
	const config = normalizeExplorerConfig(settings);
	const buildConfig = explorerBuildConfig(config);
	const language = normalizeExplorerLanguage(inputLanguage);
	const sourcePath = explorerSourcePath(language);
	const strippedSource =
		language === "typescript" ? stripCompactTypes(source, sourcePath) : source;
	const parsed = parseModule(strippedSource);
	traverseEstree(parsed.ast, (node) => {
		if (
			node.type === "ImportDeclaration" ||
			node.type === "ImportExpression" ||
			node.type === "ExportAllDeclaration" ||
			(node.type === "ExportNamedDeclaration" && node.source !== null)
		) {
			throw new SyntaxError(
				`Module imports are unavailable in the single-file explorer at ${node.loc?.start.line ?? 1}:${node.loc?.start.column ?? 0}`,
			);
		}
	});
	const graph: ModuleGraph = {
		entry: sourcePath,
		nodeEnabled: config.node,
		modules: new Map([
			[
				sourcePath,
				{
					path: sourcePath,
					goal: "module",
					source: strippedSource,
					parsed,
					dependencies: [],
					virtual: true,
				},
			],
		]),
		evaluationOrder: [sourcePath],
		cycles: [],
	};
	const semantic = runSemanticAnalysisForGraph(graph);
	const facts = withProgramClosure(
		compilerProgramFactsFromConfig(buildConfig),
		certifyProgramClosure(graph, buildConfig, {
			relocatableArtifact: false,
			hostWireSplicing: false,
		}),
	);
	const diagnostics = validateSemanticBuildPolicy(semantic, buildConfig, facts.world);
	const core = lowerSemanticProgramToCore(semantic, { facts });
	const preCore = formatCore(core.program);
	const result = optimizeCore(core, { instrumentation: "full" });
	return {
		preCore,
		result,
		config,
		diagnostics,
		facts,
		language,
		strippedSource,
	};
}

function genericPlan(plan: CoreOptimizationPlan): CoreOptimizationPlan {
	const discovered = Object.values(plan.statistics.discoveredByKind).reduce(
		(total, count) => total + count,
		0,
	);
	const zeroed = <Key extends string>(record: Readonly<Record<Key, number>>) =>
		Object.fromEntries(Object.keys(record).map((key) => [key, 0])) as Record<Key, number>;
	return Object.freeze({
		...plan,
		directEntries: Object.freeze([]),
		recipes: buildCoreSpecializationRecipeTable([]),
		statistics: Object.freeze({
			considered: discovered,
			applied: 0,
			declined: discovered,
			admittedFunctions: 0,
			appliedByKind: Object.freeze(zeroed(plan.statistics.appliedByKind)),
			declinedByReason: Object.freeze(zeroed(plan.statistics.declinedByReason)),
			generatedCodeConsumed: 0,
			compilerWorkConsumed: 0,
			discoveredByKind: plan.statistics.discoveredByKind,
			selectedByKind: Object.freeze({}),
			declinedByPlanReason: Object.freeze({
				...(discovered === 0 ? {} : { "tooling-generic-path": discovered }),
			}),
			verificationMs: 0,
		}),
	});
}

function genericReport(
	report: CoreOptimizationReport,
	plan: CoreOptimizationPlan,
): CoreOptimizationReport {
	return Object.freeze({
		...report,
		output: Object.freeze({ ...report.output, planCandidates: 0 }),
		plan: Object.freeze({
			...report.plan,
			selected: 0,
			declined: report.plan.discovered,
			selectedByKind: Object.freeze({}),
			declinedByReason: Object.freeze({
				...(report.plan.discovered === 0
					? {}
					: { "tooling-generic-path": report.plan.discovered }),
			}),
			generatedCodeConsumed: 0,
			compilerWorkConsumed: 0,
			verificationMs: plan.statistics.verificationMs,
		}),
	});
}

export function compileMode(
	compiled: ReturnType<typeof compileExplorerCore>,
	mode: ModeId,
) {
	const plan =
		mode === "full"
			? compiled.result.compilation.plan
			: verifyCoreOptimizationPlan(
					compiled.result.compilation.program,
					genericPlan(compiled.result.compilation.plan),
				);
	const optimized: CoreCompilation =
		mode === "full"
			? compiled.result.compilation
			: Object.freeze({ ...compiled.result.compilation, plan });
	const execution = lowerCoreCompilationToExecution(optimized, {
		reuseRegisters: true,
	});
	const image = lowerExecutionToProgramImage(execution, false);
	const wire = serializeRuntimeImage(image.runtime, { debugInfo: true });
	const c = emitProgramImage(image, { compiled: true, debugInfo: true });
	return {
		preCore: compiled.preCore,
		optimizedCore: formatCore(optimized.program),
		target: formatTarget(execution, image),
		malw: formatRuntimeImage(image.runtime),
		hex: wireHex(wire),
		wire,
		c,
		trace:
			mode === "full"
				? compiled.result.report
				: genericReport(compiled.result.report, plan),
		structure: {
			strings: image.runtime.stringConstants.map((units, index) => ({
				index,
				value: decodeString(units),
				units: [...units],
			})),
			bigints: image.runtime.bigintConstants.map((value, index) => ({
				index,
				value: `${value}n`,
			})),
			functions: image.runtime.functions.map((fn, index) => ({
				index,
				name: functionName(image.runtime, fn),
				kind:
					fn.isAsync && fn.isGenerator
						? "async-generator"
						: fn.isAsync
							? "async"
							: fn.isGenerator
								? "generator"
								: "normal",
				parameters: fn.parameterCount,
				registers: fn.registerCount,
				captures: fn.capturedCount,
				instructions: fn.instructions.length,
				handlers: fn.handlers.length,
				safepoints: fn.gcSafepoints?.length ?? 0,
			})),
		},
		stats: summarizeRuntime(image.runtime, wire, c),
	};
}
