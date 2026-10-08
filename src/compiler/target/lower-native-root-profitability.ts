import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { vmInstructionWriteRegisters } from "./runtime-image.ts";
import type { BytecodeFunction } from "./runtime-image.ts";

/** Ordinary successors as two parallel tables; -1 marks an absent edge. */
function ordinarySuccessorTables(
	fn: BytecodeFunction,
): readonly [Int32Array, Int32Array] {
	const count = fn.instructions.length;
	const first = new Int32Array(count).fill(-1);
	const second = new Int32Array(count).fill(-1);
	for (let ip = 0; ip < count; ip++) {
		const instruction = fn.instructions[ip]!;
		if (instruction.opcode === "JUMP") first[ip] = instruction.targetIp;
		else if (instruction.opcode === "JUMP_IF") {
			first[ip] = instruction.targetIp;
			second[ip] = ip + 1;
		} else if (
			instruction.opcode !== "RETURN" &&
			instruction.opcode !== "THROW" &&
			instruction.opcode !== "LOAD_UNDECLARED"
		)
			first[ip] = ip + 1;
	}
	return [first, second];
}

interface NativeRootProfitabilityLoop {
	readonly start: number;
	readonly end: number;
}

export interface NativeRootProfitabilityCycle {
	has(ip: number): boolean;
}

export interface NativeRootProfitabilityContext {
	readonly loops: () => ReadonlyArray<NativeRootProfitabilityLoop>;
	readonly cycleIps: (loop: NativeRootProfitabilityLoop) => NativeRootProfitabilityCycle;
}

const EMPTY_CYCLE: NativeRootProfitabilityCycle = { has: () => false };
const FORWARD = 1;
const BACKWARD = 2;

// This policy excludes exceptional edges and throwing undeclared loads; other planners use different CFGs.
export function createNativeRootProfitabilityContext(
	fn: BytecodeFunction,
): NativeRootProfitabilityContext {
	let loops: Array<NativeRootProfitabilityLoop> | undefined;
	let successors: readonly [Int32Array, Int32Array] | undefined;
	let predecessors:
		| { readonly offsets: Int32Array; readonly sources: Int32Array }
		| undefined;
	let pending: Int32Array | undefined;
	const cycles = new Map<number, NativeRootProfitabilityCycle>();
	return {
		loops: () => {
			loops ??= fn.instructions.flatMap((instruction, ip) =>
				(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
				instruction.targetIp <= ip
					? [{ start: instruction.targetIp, end: ip }]
					: [],
			);
			return loops;
		},
		cycleIps: (loop) => {
			const previous = cycles.get(loop.end);
			if (previous !== undefined) return previous;
			const { start, end } = loop;
			const [first, second] = (successors ??= ordinarySuccessorTables(fn));
			const stack = (pending ??= new Int32Array(fn.instructions.length));
			const marks = new Uint8Array(end - start + 1);
			let depth = 0;
			const reach = (ip: number, mark: number): void => {
				if (ip < start || ip > end || (marks[ip - start]! & mark) !== 0) return;
				marks[ip - start]! |= mark;
				stack[depth++] = ip;
			};
			reach(start, FORWARD);
			while (depth > 0) {
				const ip = stack[--depth]!;
				reach(first[ip]!, FORWARD);
				reach(second[ip]!, FORWARD);
			}
			if ((marks[end - start]! & FORWARD) === 0) {
				cycles.set(end, EMPTY_CYCLE);
				return EMPTY_CYCLE;
			}
			predecessors ??= ordinaryPredecessors(first, second);
			const { offsets, sources } = predecessors;
			reach(end, BACKWARD);
			while (depth > 0) {
				const ip = stack[--depth]!;
				for (let edge = offsets[ip]!; edge < offsets[ip + 1]!; edge++)
					reach(sources[edge]!, BACKWARD);
			}
			const cycle: NativeRootProfitabilityCycle = {
				has: (ip) =>
					ip >= start && ip <= end && marks[ip - start] === (FORWARD | BACKWARD),
			};
			cycles.set(end, cycle);
			return cycle;
		},
	};
}

function ordinaryPredecessors(
	first: Int32Array,
	second: Int32Array,
): { readonly offsets: Int32Array; readonly sources: Int32Array } {
	const count = first.length;
	const offsets = new Int32Array(count + 1);
	for (const targets of [first, second])
		for (let ip = 0; ip < count; ip++) {
			const target = targets[ip]!;
			if (target >= 0 && target < count) offsets[target + 1]!++;
		}
	for (let ip = 0; ip < count; ip++) offsets[ip + 1]! += offsets[ip]!;
	const cursor = offsets.slice(0, count);
	const sources = new Int32Array(offsets[count]!);
	for (const targets of [first, second])
		for (let ip = 0; ip < count; ip++) {
			const target = targets[ip]!;
			if (target >= 0 && target < count) sources[cursor[target]!++] = ip;
		}
	return { offsets, sources };
}

function occursWithin(
	positions: ReadonlyArray<number>,
	start: number,
	end: number,
): boolean {
	let low = 0;
	let high = positions.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (positions[middle]! < start) low = middle + 1;
		else high = middle;
	}
	return low < positions.length && positions[low]! <= end;
}

/** Keep unrelated loop invariants rooted instead of copying them before each call. */
export function nativeProfitablePrivateRootRegisters(
	fn: BytecodeFunction,
	native: NativeFunctionPlan,
	candidates: ReadonlySet<number>,
	body?: Pick<NativeBodyFacts, "writes" | "rootProfitability">,
): ReadonlySet<number> {
	if (candidates.size === 0) return candidates;
	const uses = new Map(
		[...candidates].map((register) => [
			register,
			{
				writes: [] as Array<number>,
				properties: [] as Array<number>,
				calls: [] as Array<number>,
			},
		]),
	);
	const context = body?.rootProfitability ?? createNativeRootProfitabilityContext(fn);
	const points = new Map(
		native.gc.safepoints.map((point) => [point.instructionIp, point]),
	);
	for (const [ip, instruction] of fn.instructions.entries()) {
		for (const register of body?.writes[ip] ?? vmInstructionWriteRegisters(instruction))
			uses.get(register)?.writes.push(ip);
		if (native.instructions[ip] === undefined) {
			if (instruction.opcode === "LOAD_PROPERTY_STATIC") {
				uses.get(instruction.object)?.properties.push(ip);
				uses.get(instruction.dst)?.properties.push(ip);
			} else if (
				instruction.opcode === "LOAD_PROPERTY" &&
				(native.registerRepresentations[instruction.key] === "number" ||
					native.registerRepresentations[instruction.key] === "int32")
			) {
				uses.get(instruction.dst)?.properties.push(ip);
			}
		}
		if (instruction.opcode === "CALL" || instruction.opcode === "CALL_KNOWN") {
			const point = points.get(ip);
			if (point?.kind === "operation") {
				for (const register of point.incomingRootRegisters)
					uses.get(register)?.calls.push(ip);
			}
		}
	}

	const profitable = new Set(candidates);
	for (const [register, use] of uses) {
		// Unmodified parameters already have an entry-published shadow value.
		if (register < fn.parameterCount && use.writes.length === 0) continue;
		// Count costs and benefits on the same repeatable cycle. A one-way exit
		// can define the next outer-loop value without helping the inner loop.
		if (
			context.loops().some((loop) => {
				const { start, end } = loop;
				if (!occursWithin(use.calls, start, end)) return false;
				const cycle = context.cycleIps(loop);
				return (
					use.calls.some((ip) => cycle.has(ip)) &&
					!use.writes.some((ip) => cycle.has(ip)) &&
					!use.properties.some((ip) => cycle.has(ip))
				);
			})
		)
			profitable.delete(register);
	}
	return profitable;
}
