import { NO_EFFECT_SUMMARY, joinEffectSummaries } from "../shared/effect-summary.ts";
import type { RelativeOwnSlotEffectSummary } from "../shared/effect-summary.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CoreEditor } from "./core-editor.ts";
import {
	removeInstructionAndOwnedProof,
	removeUnsharedProof,
} from "./core-effect-proof-edits.ts";
import { coreCalleeTargetsAreOpen } from "./core-ir-call-targets.ts";
import type { CoreIndexedCallSite } from "./core-ir-call-targets.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreCanonicalValueRoots,
} from "./core-ir-control-flow.ts";
import { analyzeCoreMemoryVersions, coreMemoryAccesses } from "./core-ir-memory.ts";
import type {
	CoreMemoryAccess,
	CoreMemoryInstructionTransfer,
} from "./core-ir-memory.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import { buildCoreProvenance } from "./core-ir-provenance.ts";
import type { CoreAccessKey, CoreProvenance } from "./core-ir-provenance.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { CORE_PROGRAM_FLOW_ANALYSIS } from "./core-program-flow-analysis.ts";
import { CORE_FUNCTION_VERSION_DOMAINS } from "./core-store.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface RelativeCallerAccess {
	readonly base: CoreValueId;
	readonly key: CoreAccessKey;
	readonly mode: "read" | "write";
}

interface ConditionalCall {
	readonly instruction: CoreInstructionId;
	readonly accesses: ReadonlyArray<RelativeCallerAccess>;
	readonly nonRetainingOperands: ReadonlySet<number>;
	readonly residualEffects: CoreMemoryInstructionTransfer["residualEffects"];
}

function hasOwnSlotLoad(fn: CoreFunctionStore): boolean {
	for (const instruction of fn.instructionIds()) {
		if (
			fn.instructionKind(instruction) === "operation" &&
			fn.instructionOpcodeName(instruction) === "loadPropertyStatic"
		)
			return true;
	}
	return false;
}

function conditionalCall(
	fn: CoreFunctionStore,
	site: CoreIndexedCallSite,
	summaries: ReadonlyArray<RelativeOwnSlotEffectSummary>,
): ConditionalCall | undefined {
	if (
		site.transfer.invocation !== "call" ||
		site.transfer.arguments.kind !== "positional" ||
		site.arguments === undefined
	)
		return undefined;
	const accesses: Array<RelativeCallerAccess> = [];
	const nonRetainingOperands = new Set<number>();
	for (let index = 0; index < site.arguments.length; index++) {
		if (
			summaries.every((summary) => (summary.parameterEscape[index] ?? "none") === "none")
		)
			nonRetainingOperands.add(site.transfer.arguments.firstOperand + index);
	}
	if (
		site.transfer.receiverOperand !== undefined &&
		summaries.every((summary) => summary.receiverEscape === "none")
	)
		nonRetainingOperands.add(site.transfer.receiverOperand);
	let residualEffects = NO_EFFECT_SUMMARY;
	for (const summary of summaries) {
		residualEffects = joinEffectSummaries(residualEffects, summary.residualEffects);
		for (const access of summary.accesses) {
			const base =
				access.base.kind === "receiver"
					? site.receiver
					: site.arguments[access.base.index];
			if (base === undefined) return undefined;
			accesses.push({
				base,
				key: { kind: "string-constant", index: access.key },
				mode: access.mode,
			});
		}
	}
	const invocationEffects = coreInstructionEffects(fn, site.instruction);
	return {
		instruction: site.instruction,
		accesses,
		nonRetainingOperands,
		residualEffects: {
			...residualEffects,
			mayThrow: residualEffects.mayThrow || invocationEffects.mayThrow,
			mayGc: residualEffects.mayGc || invocationEffects.mayGc,
		},
	};
}

function resolveAccess(
	provenance: CoreProvenance,
	access: RelativeCallerAccess,
): CoreMemoryAccess | undefined {
	const resolved = provenance.ownCell(access.base, access.key, access.mode);
	if (resolved === undefined) return undefined;
	return {
		...access,
		location:
			resolved.cell.kind === "object-slot"
				? {
						kind: "object-slot",
						allocation: resolved.layout.instruction,
						key: resolved.cell.key,
					}
				: {
						kind: "element",
						allocation: resolved.layout.instruction,
						index: resolved.cell.index,
					},
	};
}

export function forwardCoreOwnSlotCallLoads(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
): ReadonlyArray<CoreFunctionId> {
	const changed: Array<CoreFunctionId> = [];
	let remainingWork = 32_768;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		if (fn.instructionCapacity > 4_096 || fn.instructionCapacity > remainingWork)
			continue;
		if (!hasOwnSlotLoad(fn)) continue;
		// Earlier callers may also be later callees; refresh before consuming their summaries.
		const flow = analyses.get(CORE_PROGRAM_FLOW_ANALYSIS, { scope: "program" });
		const calls = new Map<CoreInstructionId, ConditionalCall>();
		const dependencies = new Map<CoreFunctionStore, CoreFunctionStore["versions"]>([
			[fn, fn.versions],
		]);
		for (const site of flow.targets.outgoing(functionId)) {
			if (
				coreCalleeTargetsAreOpen(site.targets) ||
				site.targets.functions.length === 0 ||
				site.targets.functions.length > 4
			)
				continue;
			const summaries: Array<RelativeOwnSlotEffectSummary> = [];
			for (const target of site.targets.functions) {
				const summary = flow.summaries.summary(target)?.conditionalOwnSlotEffects;
				if (summary === undefined) break;
				summaries.push(summary);
				const callee = program.function(target);
				dependencies.set(callee, callee.versions);
			}
			if (summaries.length !== site.targets.functions.length) continue;
			const candidate = conditionalCall(fn, site, summaries);
			if (candidate !== undefined) calls.set(site.instruction, candidate);
		}
		if (calls.size === 0 || calls.size > 64) continue;
		const control = analyses
			.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, { scope: "function", function: functionId })
			.exceptional();
		const roots = coreCanonicalValueRoots(fn, control);
		let provenance: CoreProvenance | undefined;
		let resolvedCalls: Map<CoreInstructionId, CoreMemoryInstructionTransfer> | undefined;
		// Dropping an invalid call can invalidate another aggregate's containment assumption.
		for (let iteration = 0; iteration < 8 && calls.size > 0; iteration++) {
			if (remainingWork < fn.instructionCapacity) break;
			remainingWork -= fn.instructionCapacity;
			provenance = buildCoreProvenance(program, fn, control, {
				canonicalRoots: roots,
				nonRetainingCallOperands: new Map(
					[...calls].map(([instruction, call]) => [
						instruction,
						call.nonRetainingOperands,
					]),
				),
			});
			const transfers = new Map<CoreInstructionId, CoreMemoryInstructionTransfer>();
			let declined = false;
			for (const [instruction, call] of calls) {
				const accesses: Array<CoreMemoryAccess> = [];
				for (const access of call.accesses) {
					const resolved = resolveAccess(provenance, access);
					if (resolved === undefined) break;
					accesses.push(resolved);
				}
				if (accesses.length !== call.accesses.length) {
					calls.delete(instruction);
					declined = true;
				} else
					transfers.set(instruction, { accesses, residualEffects: call.residualEffects });
			}
			if (!declined) {
				resolvedCalls = transfers;
				break;
			}
		}
		if (provenance === undefined || resolvedCalls === undefined) continue;
		const generation = program.generation,
			dataVersion = program.programVersion("data");
		const assertCurrent = (): void => {
			if (
				program.generation !== generation ||
				program.programVersion("data") !== dataVersion ||
				[...dependencies].some(
					([dependency, versions]) =>
						program.function(dependency.id) !== dependency ||
						CORE_FUNCTION_VERSION_DOMAINS.some(
							(domain) => dependency.version(domain) !== versions[domain],
						),
				)
			)
				throw new Error("Stale conditional call memory proof");
		};
		const memory = analyzeCoreMemoryVersions(program, functionId, {
			control,
			canonicalRoots: roots,
			provenance,
			instructionTransfers: resolvedCalls,
			assertCurrent,
		});
		const replacements = new Map<
			CoreInstructionId,
			{
				readonly result: CoreValueId;
				readonly value: CoreValueId;
				readonly boxed: boolean;
			}
		>();
		for (const instruction of fn.instructionIds()) {
			if (
				fn.instructionKind(instruction) !== "operation" ||
				fn.instructionOpcodeName(instruction) !== "loadPropertyStatic" ||
				fn.kernel.instructionResultCount(instruction) !== 1
			)
				continue;
			for (const access of coreMemoryAccesses(fn, instruction, {
				ownCell(base, key, mode) {
					const resolved = provenance.ownCell(base, key, mode);
					return resolved === undefined
						? undefined
						: { allocation: resolved.layout.instruction, cell: resolved.cell };
				},
			})) {
				if (
					access.mode !== "read" ||
					(access.location.kind !== "object-slot" && access.location.kind !== "element")
				)
					continue;
				const value = memory.valueForRead(instruction, access.location),
					result = fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
				if (value === undefined || value === result) continue;
				const source = fn.valueRepresentation(value),
					destination = fn.valueRepresentation(result);
				if (source === destination)
					replacements.set(instruction, { result, value, boxed: false });
				else if (
					destination === "boxed" &&
					(source === "i32" || source === "f64" || source === "boolean")
				)
					replacements.set(instruction, { result, value, boxed: true });
			}
		}
		if (replacements.size === 0) continue;
		assertCurrent();
		const replacementsByResult = new Map(
			[...replacements.values()]
				.filter((replacement) => !replacement.boxed)
				.map((replacement) => [replacement.result, replacement.value]),
		);
		const finalValue = (value: CoreValueId): CoreValueId => {
			const seen = new Set<CoreValueId>();
			let current = value;
			while (!seen.has(current)) {
				seen.add(current);
				const next = replacementsByResult.get(current);
				if (next === undefined) break;
				current = next;
			}
			return current;
		};
		const editor = CoreEditor.open(program, functionId);
		for (const [instruction, replacement] of replacements) {
			const value = finalValue(replacement.value);
			if (replacement.boxed) {
				const proof = fn.instructionEffectRefinement(instruction)?.proof;
				editor.replaceInstruction(instruction, "move", [value], {
					sourcePosition: fn.instructionSourcePosition(instruction),
				});
				removeUnsharedProof(editor, fn, proof);
			} else {
				editor.replaceValueUses(replacement.result, value);
				removeInstructionAndOwnedProof(editor, fn, instruction);
			}
		}
		editor.commit();
		changed.push(functionId);
	}
	return changed;
}
