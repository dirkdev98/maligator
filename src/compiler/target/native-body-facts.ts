import { createNativeRootProfitabilityContext } from "./lower-native-root-profitability.ts";
import type { NativeRootProfitabilityContext } from "./lower-native-root-profitability.ts";
import { nativeControlFlowEntries } from "./native-control-flow.ts";
import type {
	NativeControlFlowEntryOptions,
	NativeControlFlowPlan,
} from "./native-control-flow.ts";
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
	options: NativeControlFlowEntryOptions,
): NativeBodyFacts {
	if (controlFlow === undefined) return body;
	const count = native.body.instructions.length;
	const unreachable = new Set(controlFlow.unreachableIps);
	const branches = new Map(
		controlFlow.branches.map(({ instructionIp, targetIp }) => [instructionIp, targetIp]),
	);
	const entries = new Set(
		[...nativeControlFlowEntries(native, body, options).roots].filter(
			(ip) => ip >= 0 && ip < count && !unreachable.has(ip),
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

// Helper and handler labels can supply independent state despite a single ordinary predecessor.
export function nativeBodyLinearFlow(fn: BytecodeFunction, body: NativeBodyFacts) {
	const count = fn.instructions.length;
	const successors = new Int32Array(count).fill(-1);
	const predecessors = new Int32Array(count).fill(-1);
	const unreachable = body.projection?.unreachable;
	const add = (from: number, to: number) => {
		if (to < 0 || to >= count || unreachable?.has(to)) return;
		const prior = successors[from]!;
		successors[from] = prior === -1 || prior === to ? to : -2;
		const incoming = predecessors[to]!;
		predecessors[to] = incoming === -1 || incoming === from ? from : -2;
	};
	for (const [ip, op] of fn.instructions.entries()) {
		if (unreachable?.has(ip)) continue;
		const fixed = body.projection?.branches.get(ip);
		if (fixed !== undefined) add(ip, fixed);
		else {
			if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") add(ip, op.targetIp);
			if (
				![
					"JUMP",
					"RETURN",
					"THROW",
					"LOAD_UNDECLARED",
					"YIELD",
					"AWAIT",
					"TERMINAL_YIELD",
				].includes(op.opcode)
			)
				add(ip, ip + 1);
		}
	}
	return {
		next(ip: number): number | undefined {
			const target = successors[ip]!;
			return target >= 0 &&
				!body.externalEntries.has(target) &&
				predecessors[target] === ip
				? target
				: undefined;
		},
		previous(ip: number): number | undefined {
			const source = predecessors[ip]!;
			return source >= 0 && !body.externalEntries.has(ip) && successors[source] === ip
				? source
				: undefined;
		},
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

export function bytecodePredecessors(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	ip: number,
): Array<number> {
	const previous = fn.instructions[ip - 1];
	return [
		...(body.branchSources.get(ip) ?? []),
		...(previous !== undefined &&
		previous.opcode !== "JUMP" &&
		previous.opcode !== "RETURN" &&
		previous.opcode !== "THROW"
			? [ip - 1]
			: []),
	];
}

/**
 * Whether every path from an entry to `target` runs `dominator` first. Handler targets
 * count as entries, since their throwing edges are not branch sources.
 */
export function bytecodeDominates(
	fn: BytecodeFunction,
	body: NativeBodyFacts,
	dominator: number,
	target: number,
): boolean {
	const visited = new Set<number>([dominator]);
	const pending = [target];
	while (pending.length > 0) {
		const ip = pending.pop()!;
		if (visited.has(ip)) continue;
		visited.add(ip);
		if (ip === 0 || body.externalEntries.has(ip) || body.handlerTargets[ip] !== undefined)
			return false;
		pending.push(...bytecodePredecessors(fn, body, ip));
	}
	return true;
}

const singleWriterCache = new WeakMap<NativeBodyFacts, ReadonlyMap<number, number>>();

/** Each register written by exactly one instruction, with that instruction. */
export function singleWriters(body: NativeBodyFacts): ReadonlyMap<number, number> {
	const cached = singleWriterCache.get(body);
	if (cached !== undefined) return cached;
	const writers = new Map<number, number>();
	const repeated = new Set<number>();
	for (const [ip, written] of body.writes.entries())
		for (const register of written) {
			if (writers.has(register)) repeated.add(register);
			writers.set(register, ip);
		}
	for (const register of repeated) writers.delete(register);
	singleWriterCache.set(body, writers);
	return writers;
}
