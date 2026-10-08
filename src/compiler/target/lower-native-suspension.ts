import type { NativeBodyFacts } from "./native-body-facts.ts";
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
	body?: Pick<NativeBodyFacts, "reads" | "writes" | "handlerTargets">,
): NativeSuspensionPlan | undefined {
	if (native.mode !== "resumable") return undefined;
	const fn = native.body;
	if (fn.instructions.length === 0) return suspensionLayout([]);
	const handlers =
		body?.handlerTargets ??
		vmExceptionHandlerTargets(fn.instructions.length, fn.handlers);
	const reads = body?.reads ?? fn.instructions.map(vmInstructionReadRegisters);
	const writes = body?.writes ?? fn.instructions.map(vmInstructionWriteRegisters);
	const starts = new Uint8Array(fn.instructions.length);
	starts[0] = 1;
	const mark = (ip: number) => {
		if (!Number.isInteger(ip) || ip < 0 || ip >= starts.length)
			throw new Error("Invalid suspension control-flow target");
		starts[ip] = 1;
	};
	for (const [ip, op] of fn.instructions.entries()) {
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") mark(op.targetIp);
		if (handlers[ip] !== undefined) mark(handlers[ip]);
		if (ip > 0 && handlers[ip] !== handlers[ip - 1]) mark(ip);
		if (
			ip + 1 < starts.length &&
			[
				"JUMP",
				"JUMP_IF",
				"RETURN",
				"THROW",
				"TERMINAL_YIELD",
				"GENERATOR_START",
				"YIELD",
				"AWAIT",
			].includes(op.opcode)
		)
			mark(ip + 1);
	}
	const blockStarts = fn.instructions.flatMap((_, ip) => (starts[ip] ? [ip] : []));
	const blockAt = new Int32Array(fn.instructions.length);
	const blocks = blockStarts.map((start, index) => {
		const end = blockStarts[index + 1] ?? fn.instructions.length;
		blockAt.fill(index, start, end);
		const generated = new Set<number>();
		const killed = new Set<number>();
		for (let ip = start; ip < end; ip++) {
			for (const register of reads[ip]!)
				if (register >= 0 && !killed.has(register)) generated.add(register);
			for (const register of writes[ip]!) if (register >= 0) killed.add(register);
		}
		return { start, end, generated: [...generated], killed: [...killed] };
	});
	const successors = blocks.map(({ end }) => {
		const ip = end - 1;
		const op = fn.instructions[ip]!;
		const next: Array<number> = [];
		if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") next.push(blockAt[op.targetIp]!);
		if (
			op.opcode !== "JUMP" &&
			op.opcode !== "RETURN" &&
			op.opcode !== "THROW" &&
			op.opcode !== "TERMINAL_YIELD" &&
			end < fn.instructions.length
		)
			next.push(blockAt[end]!);
		return [...new Set(next)];
	});
	const handlerBlocks = blocks.map(({ start }) =>
		handlers[start] === undefined ? undefined : blockAt[handlers[start]]!,
	);
	const predecessors: Array<Array<number>> = blocks.map(() => []);
	for (const [block, targets] of successors.entries()) {
		for (const target of targets) predecessors[target]!.push(block);
		const handler = handlerBlocks[block];
		if (handler !== undefined && !targets.includes(handler))
			predecessors[handler]!.push(block);
	}
	const wordCount = Math.ceil(fn.registerCount / 32);
	const live = blocks.map(() => new Uint32Array(wordCount));
	const pending = blocks.map((_, block) => block);
	const queued = new Uint8Array(blocks.length).fill(1);
	const scratch = new Uint32Array(wordCount);
	while (pending.length > 0) {
		const block = pending.pop()!;
		queued[block] = 0;
		scratch.fill(0);
		for (const next of successors[block]!)
			for (let word = 0; word < wordCount; word++) scratch[word]! |= live[next]![word]!;
		for (const register of blocks[block]!.killed)
			scratch[register >>> 5]! &= ~(1 << (register & 31));
		for (const register of blocks[block]!.generated)
			scratch[register >>> 5]! |= 1 << (register & 31);
		// Every instruction shares this handler, so its incoming values survive the whole block's definitions.
		const handler = handlerBlocks[block];
		if (handler !== undefined)
			for (let word = 0; word < wordCount; word++)
				scratch[word]! |= live[handler]![word]!;
		if (scratch.every((value, word) => value === live[block]![word])) continue;
		live[block]!.set(scratch);
		for (const predecessor of predecessors[block]!) {
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
		const block = blockAt[ip]!;
		const nextBlocks = [...successors[block]!];
		const handler = handlerBlocks[block];
		if (handler !== undefined) nextBlocks.push(handler);
		for (const next of nextBlocks)
			for (let word = 0; word < wordCount; word++) {
				let bits = live[next]![word]!;
				while (bits !== 0) {
					const register = word * 32 + 31 - Math.clz32(bits & -bits);
					if (
						register < fn.registerCount &&
						native.registerRepresentations[register] !== "boxed" &&
						native.registerRepresentations[register] !== "string"
					)
						registers.add(register);
					bits = (bits & (bits - 1)) >>> 0;
				}
			}
		// Only GC-owned heap locals are safe to copy; conservative handler edges can name stale bits.
		for (const register of roots.get(ip) ?? []) registers.add(register);
		if (op.opcode !== "GENERATOR_START") {
			registers.delete(op.valueDst);
			registers.delete(op.modeDst);
		}
		const ordered = [...registers].sort((a, b) => a - b);
		points.push({ instructionIp: ip, registers: ordered });
	}
	return suspensionLayout(points);
}

export function compactNativeSuspension(
	plan: NativeSuspensionPlan | undefined,
	rematerializedRegisters: ReadonlySet<number>,
): NativeSuspensionPlan | undefined {
	if (plan === undefined) return undefined;
	const points = plan.points.map((point) => ({
		...point,
		registers: point.registers.filter(
			(register) => !rematerializedRegisters.has(register),
		),
	}));
	return suspensionLayout(points);
}

function suspensionLayout(
	points: ReadonlyArray<NativeSuspensionPoint>,
): NativeSuspensionPlan {
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
