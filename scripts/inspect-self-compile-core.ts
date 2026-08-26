import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { CoreCompilationContext } from "../src/compiler/core/core-compilation.ts";
import { analyzeCoreInterproceduralValueFlow } from "../src/compiler/core/core-ir-interprocedural-flow.ts";
import {
	CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
	CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE,
} from "../src/compiler/core/core-ir-provenance.ts";
import { analyzeCoreProgramSummaries } from "../src/compiler/core/core-ir-summaries.ts";
import {
	analyzeCoreValueClasses,
	CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE,
	CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE,
} from "../src/compiler/core/core-ir-value-classes.ts";
import {
	analyzeCoreValueKinds,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
} from "../src/compiler/core/core-ir-value-kinds.ts";
import type { CoreInstruction, CoreProgram } from "../src/compiler/core/core-ir.ts";
import { optimizeSemanticProgramToCore } from "../src/compiler/pipeline/compile-core-common.ts";
import { analyzeEntrypoint } from "../src/compiler/pipeline/compile-program-common.ts";
import { lowerCoreCompilationToExecution } from "../src/compiler/target/lower-native-execution.ts";
import {
	prepareSelfCompileSource,
	SELF_COMPILE_CONFIG,
} from "./self-compile-workload.ts";

interface ArrayStackSite {
	readonly operation:
		| "Array.prototype.push"
		| "Array.prototype.pop"
		| "contained dense element read";
	readonly lowering: "exact" | "guarded";
	readonly sourcePath: string;
	readonly line: number;
	readonly column: number;
}

interface CoreInstructionSite {
	readonly functionIndex: number;
	readonly block: number;
	readonly instruction: number;
	readonly opcode: string;
	readonly inputs: ReadonlyArray<number>;
	readonly outputs: ReadonlyArray<number>;
	readonly attributes: CoreInstruction["attributes"];
	readonly effectProofKind?: string;
	readonly exactReceiverBrand?: string;
	readonly containedCollection?: string;
	readonly sourcePath: string;
	readonly line: number;
	readonly column: number;
}

function attributeObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? (value as Readonly<Record<string, unknown>>)
		: undefined;
}

function arrayStackOperation(
	instruction: CoreInstruction,
): ArrayStackSite["operation"] | undefined {
	const operation =
		instruction.opcode === "callBuiltin"
			? instruction.attributes.operation
			: attributeObject(instruction.attributes.knownBuiltinCall)?.operation;
	return operation === "Array.prototype.push" || operation === "Array.prototype.pop"
		? operation
		: undefined;
}

const root = mkdtempSync(path.join(os.tmpdir(), "mal-inspect-self-compile-core-"));
try {
	const sourceRoot = path.join(root, "source");
	const fullTarget = prepareSelfCompileSource(sourceRoot);
	const entryIndex = process.argv.indexOf("--entry");
	const entry = entryIndex < 0 ? undefined : process.argv[entryIndex + 1];
	if (
		entryIndex >= 0 &&
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
	const roundsIndex = process.argv.indexOf("--rounds");
	const rounds = roundsIndex < 0 ? undefined : Number(process.argv[roundsIndex + 1]);
	if (roundsIndex >= 0 && (!Number.isSafeInteger(rounds) || rounds! < 1)) {
		throw new Error("--rounds requires a positive integer");
	}
	const runPhase = <T>(phase: string, run: () => T): T => {
		const startedAt = performance.now();
		const result = run();
		phases[phase] = (phases[phase] ?? 0) + performance.now() - startedAt;
		return result;
	};
	const { semantic, facts } = analyzeEntrypoint(
		target,
		{
			buildConfig: SELF_COMPILE_CONFIG,
			stripTypes: (source) => source,
		},
		runPhase,
	);
	const optimizedCompilation = optimizeSemanticProgramToCore(
		semantic,
		{
			facts,
			...(rounds === undefined ? {} : { optimizationRounds: rounds }),
		},
		runPhase,
	);
	const optimized: CoreProgram = optimizedCompilation.program;
	const optimizedContext: CoreCompilationContext = optimizedCompilation.context;
	const valueClasses = analyzeCoreValueClasses(optimized, optimizedContext);
	const summaries = analyzeCoreProgramSummaries(optimized, undefined, optimizedContext);
	const valueFlow = analyzeCoreInterproceduralValueFlow(optimized, summaries);
	const valueKinds = analyzeCoreValueKinds(optimized, optimizedContext, summaries);
	const native = process.argv.includes("--native")
		? runPhase("lowerNativeMs", () =>
				lowerCoreCompilationToExecution(optimizedCompilation),
			)
		: undefined;
	const callbackCalls =
		native?.functions.flatMap((fn) =>
			fn.blocks.flatMap(({ instructions }) =>
				instructions.flatMap((instruction) =>
					instruction.type === "call" &&
					instruction.directCallbackFunctionIndex !== undefined
						? [
								{
									operation: instruction.knownBuiltinCall?.operation ?? "unknown",
									target: instruction.directCallbackFunctionIndex,
								},
							]
						: [],
				),
			),
		) ?? [];

	const sites: Array<ArrayStackSite> = [];
	const instructionSites: Array<CoreInstructionSite> = [];
	for (const fn of optimized.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const sitePosition =
					instruction.sourcePosition === undefined
						? undefined
						: optimized.sourcePositions[instruction.sourcePosition];
				const siteOwner =
					sitePosition?.inlinedFunctionIndex === undefined
						? fn
						: optimized.functions.find(
								(candidate) =>
									candidate.functionIndex === sitePosition.inlinedFunctionIndex,
							);
				instructionSites.push({
					functionIndex: fn.functionIndex,
					block: block.id,
					instruction: instruction.id,
					opcode: instruction.opcode,
					inputs: instruction.inputs,
					outputs: instruction.outputs,
					attributes: instruction.attributes,
					...((instruction.opcode === "call"
						? instruction.inputs[1]
						: instruction.inputs[0]) === undefined
						? {}
						: {
								exactReceiverBrand: valueClasses.exactHeapBrand(
									fn.functionIndex,
									(instruction.opcode === "call"
										? instruction.inputs[1]
										: instruction.inputs[0])!,
									instruction.id,
								),
							}),
					...(instruction.opcode !== "call" || instruction.inputs[1] === undefined
						? {}
						: {
								containedCollection: valueClasses.containedCollection(
									fn.functionIndex,
									instruction.inputs[1],
									instruction.id,
								),
							}),
					...(instruction.effectRefinement === undefined
						? {}
						: {
								effectProofKind: fn.facts.find(
									(fact) => fact.id === instruction.effectRefinement!.proof,
								)?.kind,
							}),
					sourcePath: path.relative(
						sourceRoot,
						siteOwner?.metadata.sourcePath ?? fn.metadata.sourcePath,
					),
					line: sitePosition?.line ?? 0,
					column: sitePosition?.column ?? 0,
				});
				const operation =
					instruction.attributes[CORE_CONTAINED_DENSE_ARRAY_ELEMENT_ATTRIBUTE] === true
						? "contained dense element read"
						: arrayStackOperation(instruction);
				if (operation === undefined || instruction.sourcePosition === undefined) continue;
				const position = optimized.sourcePositions[instruction.sourcePosition];
				if (position === undefined) continue;
				const owner =
					position.inlinedFunctionIndex === undefined
						? fn
						: optimized.functions.find(
								(candidate) => candidate.functionIndex === position.inlinedFunctionIndex,
							);
				if (owner === undefined) continue;
				sites.push({
					operation,
					lowering:
						instruction.opcode === "callBuiltin" ||
						operation === "contained dense element read"
							? "exact"
							: "guarded",
					sourcePath: path.relative(sourceRoot, owner.metadata.sourcePath),
					line: position.line,
					column: position.column,
				});
			}
		}
	}
	sites.sort(
		(left, right) =>
			left.sourcePath.localeCompare(right.sourcePath) ||
			left.line - right.line ||
			left.column - right.column ||
			left.operation.localeCompare(right.operation),
	);
	const grouped = new Map<
		string,
		{
			exactPush: number;
			exactPop: number;
			exactElementRead: number;
			guardedPush: number;
			guardedPop: number;
		}
	>();
	for (const site of sites) {
		const counts = grouped.get(site.sourcePath) ?? {
			exactPush: 0,
			exactPop: 0,
			exactElementRead: 0,
			guardedPush: 0,
			guardedPop: 0,
		};
		const field =
			site.operation === "contained dense element read"
				? "exactElementRead"
				: site.lowering === "exact"
					? site.operation === "Array.prototype.push"
						? "exactPush"
						: "exactPop"
					: site.operation === "Array.prototype.push"
						? "guardedPush"
						: "guardedPop";
		counts[field]++;
		grouped.set(site.sourcePath, counts);
	}
	const filterIndex = process.argv.indexOf("--filter");
	const filter = filterIndex < 0 ? undefined : process.argv[filterIndex + 1];
	if (filterIndex >= 0 && filter === undefined) {
		throw new Error("--filter requires a source-path substring");
	}
	const selectedSites =
		filter === undefined
			? sites.filter(({ lowering }) => lowering === "exact")
			: sites.filter(({ sourcePath }) => sourcePath.includes(filter));
	const lineIndex = process.argv.indexOf("--line");
	const line = lineIndex < 0 ? undefined : Number(process.argv[lineIndex + 1]);
	if (lineIndex >= 0 && (!Number.isSafeInteger(line) || line! < 1)) {
		throw new Error("--line requires a positive integer");
	}
	const selectedInstructions =
		filter === undefined
			? []
			: instructionSites.filter(
					(site) =>
						site.sourcePath.includes(filter) &&
						(line === undefined || Math.abs(site.line - line) <= 2),
				);
	const snapshotIndex = process.argv.indexOf("--snapshot");
	const snapshot = snapshotIndex < 0 ? undefined : process.argv[snapshotIndex + 1];
	if (snapshotIndex >= 0 && snapshot === undefined) {
		throw new Error("--snapshot requires an output path");
	}
	if (snapshot !== undefined) {
		writeFileSync(
			snapshot,
			`${JSON.stringify({
				phases,
				singleAssignmentCapturedSlots:
					optimizedContext.data.singleAssignmentCapturedSlots,
				instructions: instructionSites,
			})}\n`,
		);
	}
	const functionIndex = process.argv.indexOf("--function");
	const selectedFunctionIndex =
		functionIndex < 0 ? undefined : Number(process.argv[functionIndex + 1]);
	if (
		functionIndex >= 0 &&
		(!Number.isSafeInteger(selectedFunctionIndex) || selectedFunctionIndex! < 0)
	) {
		throw new Error("--function requires a non-negative function index");
	}
	const selectedFunction =
		selectedFunctionIndex === undefined
			? undefined
			: optimized.functions.find(
					({ functionIndex }) => functionIndex === selectedFunctionIndex,
				);
	if (selectedFunctionIndex !== undefined && selectedFunction === undefined) {
		throw new Error(`unknown function index ${selectedFunctionIndex}`);
	}
	const selectedFunctionSummary =
		selectedFunctionIndex === undefined
			? undefined
			: summaries.summary(selectedFunctionIndex);
	console.log(
		JSON.stringify(
			{
				workload: process.argv.includes("--full")
					? "full"
					: entry === undefined
						? "quick"
						: `entry:${entry}`,
				phases,
				counts: {
					externallyReachableFunctions: summaries.functions.filter(
						({ externallyReachable }) => externallyReachable,
					).length,
					openCallSites: valueFlow.statistics.openSites,
					openParameterEntries: valueFlow.statistics.openParameterEntries,
					openParameterPositions: valueFlow.statistics.openParameterPositions,
					openReceiverEntries: valueFlow.statistics.openReceiverEntries,
					exactCallbackTargets: instructionSites.filter(
						({ attributes }) =>
							typeof attributes.directCallbackFunctionIndex === "number",
					).length,
					exactCallbackNativeEligible: callbackCalls.filter(({ target }) => {
						const fn = native?.functions[target];
						return fn !== undefined && !fn.isGenerator && !fn.isAsync;
					}).length,
					exactStackOperations: sites.filter(
						({ lowering, operation }) =>
							lowering === "exact" && operation !== "contained dense element read",
					).length,
					exactElementReads: sites.filter(
						({ operation }) => operation === "contained dense element read",
					).length,
					exactAggregateSlots: instructionSites.filter(
						({ effectProofKind }) =>
							effectProofKind === CORE_CONTAINED_AGGREGATE_OWN_SLOT_FACT,
					).length,
					exactTypedArrayAccesses: instructionSites.filter(
						({ attributes }) => CORE_EXACT_TYPED_ARRAY_KIND_ATTRIBUTE in attributes,
					).length,
					exactCollectionReceivers: instructionSites.filter(
						({ attributes }) => CORE_EXACT_COLLECTION_RECEIVER_ATTRIBUTE in attributes,
					).length,
					exactScalarCallSites: instructionSites.filter(
						({ attributes }) =>
							CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE in attributes,
					).length,
					exactScalarCallArguments: instructionSites.reduce((count, { attributes }) => {
						const representations =
							attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE];
						return (
							count +
							(Array.isArray(representations)
								? representations.filter(
										(representation) =>
											representation === "number" || representation === "boolean",
									).length
								: 0)
						);
					}, 0),
					exactScalarParameters: optimized.functions.reduce(
						(count, fn) =>
							count +
							fn.parameters.filter(
								(parameter) =>
									valueKinds.exactScalar(fn.functionIndex, parameter) !== undefined,
							).length,
						0,
					),
					containedCollectionReceivers: instructionSites.filter(
						({ containedCollection }) => containedCollection !== undefined,
					).length,
					guarded: sites.filter(({ lowering }) => lowering === "guarded").length,
				},
				...(native === undefined
					? {}
					: {
							typedDirectEntries: native.functions.reduce(
								(count, fn) =>
									count +
									fn.directEntries.filter(({ parameterRepresentations }) =>
										parameterRepresentations.some(
											(representation) => representation !== "boxed",
										),
									).length,
								0,
							),
							typedDirectCallSites: native.functions.reduce(
								(count, fn) =>
									count +
									fn.blocks.reduce(
										(blockCount, block) =>
											blockCount +
											block.instructions.filter(
												(instruction) =>
													instruction.type === "call" &&
													instruction.directEntryId !== undefined,
											).length,
										0,
									),
								0,
							),
							callbackCallsByOperation: Object.fromEntries(
								[...new Set(callbackCalls.map(({ operation }) => operation))]
									.sort()
									.map((operation) => [
										operation,
										{
											total: callbackCalls.filter((call) => call.operation === operation)
												.length,
											nativeEligible: callbackCalls.filter(
												(call) =>
													call.operation === operation &&
													(() => {
														const fn = native?.functions[call.target];
														return fn !== undefined && !fn.isGenerator && !fn.isAsync;
													})(),
											).length,
										},
									]),
							),
						}),
				...(process.argv.includes("--summary")
					? filter === undefined
						? {}
						: { instructions: selectedInstructions }
					: {
							bySource: [...grouped].map(([sourcePath, counts]) => ({
								sourcePath,
								...counts,
							})),
							...(filter === undefined
								? { exactSites: selectedSites }
								: { sites: selectedSites, instructions: selectedInstructions }),
						}),
				...(selectedFunction === undefined ? {} : { selectedFunction }),
				...(selectedFunctionSummary === undefined ? {} : { selectedFunctionSummary }),
			},
			undefined,
			2,
		),
	);
} finally {
	rmSync(root, { recursive: true, force: true });
}
