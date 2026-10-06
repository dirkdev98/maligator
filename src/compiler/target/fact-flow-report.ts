import type {
	CompilerFactFlowEntry,
	CompilerFactFlowEvent,
	CompilerFactFlowReport,
} from "../shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
import { executionFunctionIndex } from "./execution-ir.ts";
import type { ExecutionFunctionMap } from "./execution-ir.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import type { BytecodeInstruction, RuntimeImage } from "./runtime-image.ts";

function runtimeCallTargets(
	instruction: BytecodeInstruction | undefined,
): ReadonlyArray<number> | undefined {
	if (instruction?.opcode !== "CALL" && instruction?.opcode !== "CONSTRUCT") {
		return undefined;
	}
	if (instruction.exactFunctionIndex !== undefined) {
		return [instruction.exactFunctionIndex];
	}
	return instruction.opcode === "CALL" ? instruction.guardedFunctionIndices : undefined;
}

function nativeCallTargets(
	instruction: NativeFunctionPlan["instructions"][number],
): ReadonlyArray<number> | undefined {
	if (instruction?.kind !== "call" && instruction?.kind !== "construct") {
		return undefined;
	}
	if (instruction.directFunctionIndex !== undefined) {
		return [instruction.directFunctionIndex];
	}
	return instruction.kind === "call" ? instruction.guardedFunctionIndices : undefined;
}

function sameTargets(left: ReadonlyArray<number>, right: ReadonlyArray<number>): boolean {
	return (
		left.length === right.length && left.every((target, index) => target === right[index])
	);
}

function validNarrowing(
	produced: ReadonlyArray<number>,
	consumed: ReadonlyArray<number>,
): boolean {
	return consumed.length > 0 && consumed.every((target) => produced.includes(target));
}

function outputEvent(
	phase: "runtime-output" | "native-output",
	artifact: string,
	functionIndex: number,
	instructionIndex: number,
	consumed: ReadonlyArray<number> | undefined,
	functions: ReadonlyArray<number>,
): CompilerFactFlowEvent {
	return consumed !== undefined && validNarrowing(functions, consumed)
		? {
				phase,
				disposition: sameTargets(functions, consumed) ? "consumed" : "narrowed",
				artifact,
				functionIndex,
				instructionIndex,
				...(consumed.length === 1
					? { targetFunctionIndex: consumed[0] }
					: { targetFunctionIndices: [...consumed] }),
			}
		: {
				phase,
				disposition: "dropped",
				artifact,
				functionIndex,
				instructionIndex,
				reason:
					consumed === undefined ? "unsupported-consumer" : "representation-mismatch",
			};
}

/** Trace residual Core call-target sets through execution lowering and both outputs. */
export function collectCompilerFactFlowReport(
	facts: CompilerProgramFacts,
	functionMap: ExecutionFunctionMap,
	runtime: RuntimeImage,
	runtimeInstructionIndexes: ReadonlyArray<ReadonlyMap<object, number>>,
	nativeFunctions: ReadonlyArray<NativeFunctionPlan>,
): CompilerFactFlowReport {
	type Location = { readonly functionIndex: number; readonly instructionIndex: number };
	const runtimeLocations = new Map<string, Array<Location>>();
	const nativeLocations = new Map<string, Array<Location>>();
	const record = (
		locations: Map<string, Array<Location>>,
		siteId: string,
		location: Location,
	) => {
		const found = locations.get(siteId) ?? [];
		found.push(location);
		locations.set(siteId, found);
	};
	for (const [functionIndex, indexes] of runtimeInstructionIndexes.entries()) {
		for (const [instruction, instructionIndex] of indexes) {
			const siteId = facts.instructionSites.get(instruction)?.id;
			if (siteId !== undefined)
				record(runtimeLocations, siteId, { functionIndex, instructionIndex });
		}
	}
	for (const fn of nativeFunctions) {
		for (const [instructionIndex, siteId] of (fn.compilerSiteIds ?? []).entries()) {
			if (siteId === undefined) continue;
			record(nativeLocations, siteId, {
				functionIndex: fn.functionIndex,
				instructionIndex,
			});
		}
	}

	const entries: Array<CompilerFactFlowEntry> = [];
	for (const site of [...facts.sites.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	)) {
		if (site.callTargets?.kind !== "known") continue;
		const targets = site.callTargets.value;
		const functions = targets.functions.map((target) =>
			executionFunctionIndex(functionMap, target),
		);
		const events: Array<CompilerFactFlowEvent> = [
			{
				phase: "core-optimization",
				disposition: "produced",
				artifact: "callee-target-set",
			},
		];
		const appendOutput = (
			locations: ReadonlyMap<string, ReadonlyArray<Location>>,
			loweringPhase: "core-to-execution" | "core-to-native",
			outputPhase: "runtime-output" | "native-output",
			consumer: (location: Location) => {
				readonly targets: ReadonlyArray<number> | undefined;
				readonly artifact: string;
			},
		): void => {
			const emitted = locations.get(site.id) ?? [];
			if (emitted.length === 0) {
				events.push({
					phase: loweringPhase,
					disposition: "dropped",
					artifact: "target-instruction",
					reason: "instruction-elided",
				});
			}
			for (const location of emitted) {
				const { targets, artifact } = consumer(location);
				const event = outputEvent(
					outputPhase,
					artifact,
					location.functionIndex,
					location.instructionIndex,
					targets,
					functions,
				);
				events.push(
					{
						...event,
						phase: loweringPhase,
						artifact:
							artifact === "exactFunctionIndex" ? "directFunctionIndex" : artifact,
					},
					event,
				);
			}
		};
		appendOutput(
			runtimeLocations,
			"core-to-execution",
			"runtime-output",
			({ functionIndex, instructionIndex }) => {
				const instruction =
					runtime.functions[functionIndex]?.instructions[instructionIndex];
				return {
					targets: runtimeCallTargets(instruction),
					artifact:
						instruction?.opcode === "CALL" &&
						instruction.guardedFunctionIndices !== undefined
							? "guardedFunctionIndices"
							: "exactFunctionIndex",
				};
			},
		);
		appendOutput(
			nativeLocations,
			"core-to-native",
			"native-output",
			({ functionIndex, instructionIndex }) => {
				const instruction =
					nativeFunctions[functionIndex]?.instructions[instructionIndex];
				return {
					targets: nativeCallTargets(instruction),
					artifact:
						instruction?.kind === "call" &&
						instruction.guardedFunctionIndices !== undefined
							? "guardedFunctionIndices"
							: "directFunctionIndex",
				};
			},
		);
		entries.push({
			family: "call-targets",
			siteId: site.id,
			...(site.sourceSite === undefined ? {} : { sourceSite: site.sourceSite }),
			functions,
			anyScript: targets.anyScript,
			opaque: targets.opaque,
			events,
		});
	}

	const summary = { produced: 0, consumed: 0, narrowed: 0, dropped: 0 };
	for (const event of entries.flatMap(({ events }) => events)) {
		summary[event.disposition]++;
	}
	return { schema: 1, entries, summary };
}
