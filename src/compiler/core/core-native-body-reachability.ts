import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreCallGraphIndex } from "./core-ir-call-targets.ts";
import type { CoreDirectEntryPlan } from "./core-ir-regions.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import type { CoreProgram } from "./core-store.ts";

// Runtime identity can remain observable after every executable use selects a specialized entry.
export function coreSpecializedOnlyFunctions(
	program: CoreProgram,
	context: CoreCompilationContext | undefined,
	targets: CoreCallGraphIndex,
	liveFunctions: ReadonlyArray<CoreFunctionId>,
	entries: ReadonlyArray<CoreDirectEntryPlan>,
): ReadonlyArray<CoreFunctionId> {
	if (entries.length === 0 || context?.facts.closure.sourceClosure.kind !== "known")
		return [];
	const candidates = new Set(entries.map((entry) => entry.function));
	for (const entrypoint of program.functionIds()) {
		candidates.delete(entrypoint);
		break;
	}
	for (const functionId of context.data.cjsModuleFunctionIndices)
		candidates.delete(functionId as CoreFunctionId);
	for (const installation of context.data.hostInstallCandidates) {
		for (const { slot } of installation.exports) {
			const installed = targets.globalStoreTargets(slot);
			if (installed.anyScript) return [];
			for (const functionId of installed.functions) candidates.delete(functionId);
		}
	}
	if (candidates.size === 0) return [];
	const covered = new Map<CoreFunctionId, Map<CoreInstructionId, Set<CoreFunctionId>>>();
	for (const entry of entries) {
		for (const site of entry.callSites) {
			if (site.numericSortCallback !== undefined || site.fieldObject !== undefined)
				continue;
			const byInstruction =
				covered.get(site.caller) ?? new Map<CoreInstructionId, Set<CoreFunctionId>>();
			const callees = byInstruction.get(site.instruction) ?? new Set<CoreFunctionId>();
			callees.add(entry.function);
			byInstruction.set(site.instruction, callees);
			covered.set(site.caller, byInstruction);
		}
	}
	for (const functionId of liveFunctions) {
		if (candidates.size === 0) return [];
		const fn = program.function(functionId);
		for (const site of targets.outgoing(functionId)) {
			for (const target of site.targets.functions) {
				if (!covered.get(functionId)?.get(site.instruction)?.has(target))
					candidates.delete(target);
			}
		}
		for (const instruction of fn.instructionIds()) {
			const opcode =
				fn.instructionKind(instruction) === "operation"
					? fn.instructionOpcodeName(instruction)
					: undefined;
			if (opcode === "loadCallee") candidates.delete(functionId);
			// Private cells, SSA copies, and identity guards cannot call or export the value.
			if (
				opcode === "move" ||
				opcode === "rootUse" ||
				opcode === "guardFunctionIndex" ||
				opcode === "typeofCompare"
			)
				continue;
			if (opcode === "createModuleNamespace") {
				const exports = fn.instructionAttributes(instruction).exports as ReadonlyArray<{
					readonly slot: number;
				}>;
				for (const entry of exports) {
					for (const target of targets.globalStoreTargets(entry.slot).functions)
						candidates.delete(target);
				}
			}
			const start = fn.kernel.instructionOperandStart(instruction);
			for (
				let operand = 0;
				operand < fn.kernel.instructionOperandCount(instruction);
				operand++
			) {
				const values = targets.targets(functionId, fn.kernel.operandAt(start + operand));
				if (values.functions.length === 0) continue;
				if (opcode === undefined) {
					const kind = fn.instructionKind(instruction);
					if (
						(kind === "branch" || kind === "guard" || kind === "switch") &&
						operand === 0
					)
						continue;
					let forwarded = false;
					const edgeStart = fn.kernel.terminatorEdgeStart(instruction);
					for (
						let index = 0;
						index < fn.kernel.terminatorEdgeCount(instruction);
						index++
					) {
						const edge = edgeStart + index;
						const argument =
							start + operand - fn.kernel.terminatorEdgeArgumentStart(edge);
						if (argument < 0 || argument >= fn.kernel.terminatorEdgeArgumentCount(edge))
							continue;
						const block = fn.kernel.terminatorEdgeBlock(edge);
						const parameter = fn.kernel.blockParameterValue(
							fn.kernel.blockParameterStart(block) + argument,
						);
						const joined = targets.targets(functionId, parameter);
						forwarded =
							!joined.anyScript &&
							values.functions.every((target) => joined.functions.includes(target));
					}
					if (forwarded) continue;
				}
				if (opcode === "storeGlobal") {
					const stored = targets.globalStoreTargets(
						fn.instructionAttributes(instruction).index as number,
					);
					if (
						!stored.anyScript &&
						values.functions.every((target) => stored.functions.includes(target))
					)
						continue;
				}
				for (const target of values.functions) {
					if (
						opcode === "call" &&
						operand === 0 &&
						covered.get(functionId)?.get(instruction)?.has(target)
					)
						continue;
					candidates.delete(target);
				}
			}
		}
	}
	return [...candidates].sort((left, right) => left - right);
}
