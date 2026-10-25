import { createNativeRootProfitabilityContext } from "./lower-native-root-profitability.ts";
import type { NativeRootProfitabilityContext } from "./lower-native-root-profitability.ts";
import { nativeControlFlowEntries } from "./native-control-flow.ts";
import type { NativeControlFlowPlan } from "./native-control-flow.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import {
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeFunction } from "./runtime-image.ts";

export interface NativeBodyFacts {
	readonly projection?: NativeBodyProjection;
	readonly rootProfitability: NativeRootProfitabilityContext;
	readonly reads: ReadonlyArray<ReadonlyArray<number>>;
	readonly writes: ReadonlyArray<ReadonlyArray<number>>;
	readonly staticPropertyLoadIps: ReadonlyArray<number>;
	readonly branchSources: ReadonlyMap<number, ReadonlyArray<number>>;
	readonly handlerEntries: ReadonlySet<number>;
	readonly externalEntries: ReadonlySet<number>;
	readonly jumpTargets: ReadonlySet<number>;
	readonly handlerTargets: ReturnType<typeof vmExceptionHandlerTargets>;
}

export interface NativeBodyProjection {
	readonly branches: ReadonlyMap<number, number>;
	readonly unreachable: ReadonlySet<number>;
	readonly entries: ReadonlySet<number>;
}

export function projectNativeBodyFacts(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	controlFlow: NativeControlFlowPlan | undefined,
	externalEntries: ReadonlyArray<number>,
): NativeBodyFacts {
	if (controlFlow === undefined) return body;
	const count = native.body.instructions.length;
	const unreachable = new Set(controlFlow.unreachableIps);
	const branches = new Map(
		controlFlow.branches.map(({ instructionIp, targetIp }) => [instructionIp, targetIp]),
	);
	const entries = new Set(
		[...nativeControlFlowEntries(native, body, externalEntries).roots].filter(
			(ip) => ip >= 0 && ip < count,
		),
	);
	const external = new Set([...entries].filter((ip) => ip !== 0));
	const jumpTargets = new Set(external);
	const branchSources = new Map<number, Array<number>>();
	for (const [ip, op] of native.body.instructions.entries()) {
		if (unreachable.has(ip)) continue;
		const fixed = branches.get(ip);
		const target =
			fixed === ip + 1
				? undefined
				: (fixed ??
					(op.opcode === "JUMP" || op.opcode === "JUMP_IF" ? op.targetIp : undefined));
		if (target === undefined) continue;
		jumpTargets.add(target);
		const sources = branchSources.get(target) ?? [];
		sources.push(ip);
		branchSources.set(target, sources);
	}
	return {
		...body,
		projection: { branches, unreachable, entries },
		reads: body.reads.map((reads, ip) =>
			unreachable.has(ip) || branches.has(ip) ? [] : reads,
		),
		writes: body.writes.map((writes, ip) => (unreachable.has(ip) ? [] : writes)),
		staticPropertyLoadIps: body.staticPropertyLoadIps.filter(
			(ip) => !unreachable.has(ip),
		),
		externalEntries: external,
		jumpTargets,
		branchSources,
	};
}

// One immutable body analysis is shared within a planning or validation invocation.
export function analyzeNativeBodyFacts(fn: BytecodeFunction): NativeBodyFacts {
	const reads = fn.instructions.map(vmInstructionReadRegisters);
	const writes = fn.instructions.map(vmInstructionWriteRegisters);
	const handlerEntries = new Set(fn.handlers.map((handler) => handler.handlerIp));
	const externalEntries = new Set(handlerEntries);
	const jumpTargets = new Set(handlerEntries);
	const branchSources = new Map<number, Array<number>>();
	const staticPropertyLoadIps: Array<number> = [];
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "LOAD_PROPERTY_STATIC") staticPropertyLoadIps.push(ip);
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
		staticPropertyLoadIps,
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
