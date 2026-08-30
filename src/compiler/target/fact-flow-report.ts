import type {
	CompilerFactFlowEntry,
	CompilerFactFlowEvent,
	CompilerFactFlowReport,
} from "../shared/compiler-diagnostics.ts";
import type { CompilerProgramFacts } from "../shared/compiler-facts.ts";
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
	runtime: RuntimeImage,
	nativeFunctions: ReadonlyArray<NativeFunctionPlan>,
): CompilerFactFlowReport {
	const locations = new Map<
		string,
		Array<{ readonly functionIndex: number; readonly instructionIndex: number }>
	>();
	for (const fn of nativeFunctions) {
		for (const [instructionIndex, siteId] of (fn.compilerSiteIds ?? []).entries()) {
			if (siteId === undefined) continue;
			const found = locations.get(siteId) ?? [];
			found.push({ functionIndex: fn.functionIndex, instructionIndex });
			locations.set(siteId, found);
		}
	}

	const entries: Array<CompilerFactFlowEntry> = [];
	for (const site of [...facts.sites.values()].sort((left, right) =>
		left.id.localeCompare(right.id),
	)) {
		if (site.callTargets?.kind !== "known") continue;
		const targets = site.callTargets.value;
		const events: Array<CompilerFactFlowEvent> = [
			{
				phase: "core-optimization",
				disposition: "produced",
				artifact: "callee-target-set",
			},
		];
		const emitted = locations.get(site.id) ?? [];
		if (emitted.length === 0) {
			events.push({
				phase: "core-to-execution",
				disposition: "dropped",
				artifact: "target-instruction",
				reason: "instruction-elided",
			});
		}
		for (const { functionIndex, instructionIndex } of emitted) {
			const runtimeInstruction =
				runtime.functions[functionIndex]?.instructions[instructionIndex];
			const nativeInstruction =
				nativeFunctions[functionIndex]?.instructions[instructionIndex];
			const runtimeTargets = runtimeCallTargets(runtimeInstruction);
			const nativeTargets = nativeCallTargets(nativeInstruction);
			const selectedTargets = runtimeTargets ?? nativeTargets;
			if (
				selectedTargets === undefined ||
				!validNarrowing(targets.functions, selectedTargets)
			) {
				events.push({
					phase: "core-to-execution",
					disposition: "dropped",
					artifact: "callee-target-set",
					functionIndex,
					instructionIndex,
					reason:
						selectedTargets === undefined
							? "unsupported-consumer"
							: "representation-mismatch",
				});
				continue;
			}
			events.push({
				phase: "core-to-execution",
				disposition: sameTargets(targets.functions, selectedTargets)
					? "consumed"
					: "narrowed",
				artifact:
					selectedTargets.length === 1 ? "directFunctionIndex" : "guardedFunctionIndices",
				functionIndex,
				instructionIndex,
				...(selectedTargets.length === 1
					? { targetFunctionIndex: selectedTargets[0] }
					: { targetFunctionIndices: [...selectedTargets] }),
			});
			events.push(
				outputEvent(
					"runtime-output",
					runtimeInstruction?.opcode === "CALL" &&
						runtimeInstruction.guardedFunctionIndices !== undefined
						? "guardedFunctionIndices"
						: "exactFunctionIndex",
					functionIndex,
					instructionIndex,
					runtimeTargets,
					targets.functions,
				),
				outputEvent(
					"native-output",
					nativeInstruction?.kind === "call" &&
						nativeInstruction.guardedFunctionIndices !== undefined
						? "guardedFunctionIndices"
						: "directFunctionIndex",
					functionIndex,
					instructionIndex,
					nativeTargets,
					targets.functions,
				),
			);
		}
		entries.push({
			family: "call-targets",
			siteId: site.id,
			...(site.sourceSite === undefined ? {} : { sourceSite: site.sourceSite }),
			functions: [...targets.functions],
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
