import { createNativeRootProfitabilityContext } from "./lower-native-root-profitability.ts";
import type { NativeRootProfitabilityContext } from "./lower-native-root-profitability.ts";
import {
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction } from "./runtime-image.ts";

export interface NativeBodyFacts {
	readonly rootProfitability: NativeRootProfitabilityContext;
	readonly reads: ReadonlyArray<ReadonlyArray<number>>;
	readonly writes: ReadonlyArray<ReadonlyArray<number>>;
	readonly branchSources: ReadonlyMap<number, ReadonlyArray<number>>;
	readonly handlerEntries: ReadonlySet<number>;
	readonly externalEntries: ReadonlySet<number>;
	readonly jumpTargets: ReadonlySet<number>;
	readonly handlerTargets: ReturnType<typeof vmExceptionHandlerTargets>;
}

// One immutable body analysis is shared within a planning or validation invocation.
export function analyzeNativeBodyFacts(fn: BytecodeFunction): NativeBodyFacts {
	const reads = fn.instructions.map(vmInstructionReadRegisters);
	const writes = fn.instructions.map(vmInstructionWriteRegisters);
	const handlerEntries = new Set(fn.handlers.map((handler) => handler.handlerIp));
	const externalEntries = new Set(handlerEntries);
	const jumpTargets = new Set(handlerEntries);
	const branchSources = new Map<number, Array<number>>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") {
			jumpTargets.add(op.targetIp);
			const sources = branchSources.get(op.targetIp) ?? [];
			sources.push(ip);
			branchSources.set(op.targetIp, sources);
		}
		if (["GENERATOR_START", "YIELD", "AWAIT"].includes(op.opcode)) {
			jumpTargets.add(ip + 1);
			externalEntries.add(ip + 1);
		}
	}
	return {
		rootProfitability: createNativeRootProfitabilityContext(fn),
		reads,
		writes,
		branchSources,
		handlerEntries,
		externalEntries,
		jumpTargets,
		handlerTargets:
			fn.handlers.length === 0
				? []
				: vmExceptionHandlerTargets(fn.instructions.length, fn.handlers),
	};
}
