import type { NativeFunctionPlan } from "./program-image.ts";
import {
	vmExceptionHandlerTargets,
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";

export interface NativeSuspensionPoint {
	readonly instructionIp: number;
	// Array position is the persistent slot owned by this suspension point.
	readonly registers: ReadonlyArray<number>;
}

export interface NativeSuspensionPlan {
	readonly points: ReadonlyArray<NativeSuspensionPoint>;
	readonly valueSlot: number;
	readonly modeSlot: number;
	readonly slotCount: number;
}

export function lowerNativeSuspension(
	native: NativeFunctionPlan,
): NativeSuspensionPlan | undefined {
	if (native.mode !== "resumable") return undefined;
	const fn = native.body;
	const handlers = vmExceptionHandlerTargets(fn.instructions.length, fn.handlers);
	const successors = fn.instructions.map((op, ip) => {
		const next: Array<number> = [];
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") next.push(op.targetIp);
		if (
			op.opcode !== "JUMP" &&
			op.opcode !== "RETURN" &&
			op.opcode !== "THROW" &&
			op.opcode !== "TERMINAL_YIELD" &&
			ip + 1 < fn.instructions.length
		)
			next.push(ip + 1);
		if (handlers[ip] !== undefined) next.push(handlers[ip]);
		return [...new Set(next)];
	});
	const predecessors: Array<Array<number>> = fn.instructions.map(() => []);
	for (const [ip, targets] of successors.entries())
		for (const target of targets) predecessors[target]!.push(ip);
	const wordCount = Math.ceil(fn.registerCount / 32);
	const live = fn.instructions.map(() => new Uint32Array(wordCount));
	const reads = fn.instructions.map(vmInstructionReadRegisters);
	const writes = fn.instructions.map(vmInstructionWriteRegisters);
	const pending = fn.instructions.map((_, ip) => ip);
	const queued = new Uint8Array(fn.instructions.length).fill(1);
	const scratch = new Uint32Array(wordCount);
	while (pending.length > 0) {
		const ip = pending.pop()!;
		queued[ip] = 0;
		scratch.fill(0);
		for (const next of successors[ip]!)
			for (let word = 0; word < wordCount; word++) scratch[word]! |= live[next]![word]!;
		for (const register of writes[ip]!)
			if (register >= 0) scratch[register >>> 5]! &= ~(1 << (register & 31));
		// A throwing definition leaves the handler's incoming value unchanged.
		if (handlers[ip] !== undefined)
			for (let word = 0; word < wordCount; word++)
				scratch[word]! |= live[handlers[ip]]![word]!;
		for (const register of reads[ip]!)
			if (register >= 0) scratch[register >>> 5]! |= 1 << (register & 31);
		if (scratch.every((value, word) => value === live[ip]![word])) continue;
		live[ip]!.set(scratch);
		for (const predecessor of predecessors[ip]!) {
			if (queued[predecessor] !== 0) continue;
			queued[predecessor] = 1;
			pending.push(predecessor);
		}
	}
	const roots = new Map(
		native.gc.safepoints.map((point) => [
			point.instructionIp,
			point.outgoingRootRegisters,
		]),
	);
	const points: Array<NativeSuspensionPoint> = [];
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode !== "GENERATOR_START" && op.opcode !== "YIELD" && op.opcode !== "AWAIT")
			continue;
		const registers = new Set<number>();
		for (const next of successors[ip]!)
			for (let register = 0; register < fn.registerCount; register++)
				if (
					native.registerRepresentations[register] !== "boxed" &&
					native.registerRepresentations[register] !== "string" &&
					(live[next]![register >>> 5]! & (1 << (register & 31))) !== 0
				)
					registers.add(register);
		// Only GC-owned heap locals are safe to copy; conservative handler edges can name stale bits.
		for (const register of roots.get(ip) ?? []) registers.add(register);
		if (op.opcode !== "GENERATOR_START") {
			registers.delete(op.valueDst);
			registers.delete(op.modeDst);
		}
		const ordered = [...registers].sort((a, b) => a - b);
		points.push({ instructionIp: ip, registers: ordered });
	}
	const valueSlot = points.reduce(
		(count, point) => Math.max(count, point.registers.length),
		0,
	);
	return {
		points,
		valueSlot,
		modeSlot: valueSlot + 1,
		slotCount: valueSlot + 2,
	};
}
