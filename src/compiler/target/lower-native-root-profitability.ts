import type { NativeFunctionPlan } from "./program-image.ts";
import { vmInstructionWriteRegisters } from "./runtime-image.ts";
import type { BytecodeFunction } from "./runtime-image.ts";

function ordinarySuccessors(fn: BytecodeFunction, ip: number): ReadonlyArray<number> {
	const instruction = fn.instructions[ip]!;
	if (instruction.opcode === "JUMP") return [instruction.targetIp];
	if (instruction.opcode === "JUMP_IF") return [instruction.targetIp, ip + 1];
	if (
		instruction.opcode === "RETURN" ||
		instruction.opcode === "THROW" ||
		instruction.opcode === "LOAD_UNDECLARED"
	)
		return [];
	return [ip + 1];
}

function reachableWithin(
	start: number,
	low: number,
	high: number,
	successors: (ip: number) => ReadonlyArray<number>,
): ReadonlySet<number> {
	const reached = new Set<number>();
	const pending = [start];
	while (pending.length > 0) {
		const ip = pending.pop()!;
		if (ip < low || ip > high || reached.has(ip)) continue;
		reached.add(ip);
		pending.push(...successors(ip));
	}
	return reached;
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
	const loops: Array<{ start: number; end: number; ipsOnCycle?: ReadonlySet<number> }> =
		[];
	const points = new Map(
		native.gc.safepoints.map((point) => [point.instructionIp, point]),
	);
	for (const [ip, instruction] of fn.instructions.entries()) {
		for (const register of vmInstructionWriteRegisters(instruction))
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
		if (
			(instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF") &&
			instruction.targetIp <= ip
		)
			loops.push({ start: instruction.targetIp, end: ip });
	}
	let predecessors: ReadonlyArray<ReadonlyArray<number>> | undefined;
	const cycleIps = (loop: (typeof loops)[number]): ReadonlySet<number> => {
		if (loop.ipsOnCycle !== undefined) return loop.ipsOnCycle;
		const forward = reachableWithin(loop.start, loop.start, loop.end, (ip) =>
			ordinarySuccessors(fn, ip),
		);
		if (!forward.has(loop.end)) {
			loop.ipsOnCycle = new Set();
			return loop.ipsOnCycle;
		}
		if (predecessors === undefined) {
			const reverse: Array<Array<number>> = Array.from(
				{ length: fn.instructions.length },
				() => [],
			);
			for (let ip = 0; ip < fn.instructions.length; ip++)
				for (const target of ordinarySuccessors(fn, ip)) reverse[target]?.push(ip);
			predecessors = reverse;
		}
		const backward = reachableWithin(
			loop.end,
			loop.start,
			loop.end,
			(ip) => predecessors![ip]!,
		);
		loop.ipsOnCycle = new Set([...forward].filter((ip) => backward.has(ip)));
		return loop.ipsOnCycle;
	};
	const profitable = new Set(candidates);
	for (const [register, use] of uses) {
		// Unmodified parameters already have an entry-published shadow value.
		if (register < fn.parameterCount && use.writes.length === 0) continue;
		// Count costs and benefits on the same repeatable cycle. A one-way exit
		// can define the next outer-loop value without helping the inner loop.
		if (
			loops.some((loop) => {
				const { start, end } = loop;
				if (!occursWithin(use.calls, start, end)) return false;
				const cycle = cycleIps(loop);
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
