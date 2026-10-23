import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeInstruction } from "./runtime-image.ts";

/** A negative `producerIp` means `result` already holds the value on entry. */
export function nativeVirtualValueFlow(
	instructions: ReadonlyArray<BytecodeInstruction>,
	producerIp: number,
	result: number,
	resetIps: ReadonlySet<number> = new Set(),
	exceptionTargets: ReadonlyArray<number | undefined> = [],
) {
	// Union and intersection distinguish a live virtual alias from a register reused on one incoming path.
	const incoming = new Map<
		number,
		{ may: Set<number>; must: Set<number>; expired: Set<number> }
	>();
	const pending: Array<number> = [];
	const add = (
		ip: number,
		may: ReadonlySet<number>,
		must: ReadonlySet<number>,
		expired: ReadonlySet<number>,
	): void => {
		if (ip < 0 || ip >= instructions.length) return;
		const prior = incoming.get(ip);
		if (prior === undefined) {
			incoming.set(ip, {
				may: new Set(may),
				must: new Set(must),
				expired: new Set(expired),
			});
			pending.push(ip);
			return;
		}
		const beforeMay = prior.may.size,
			beforeMust = prior.must.size,
			beforeExpired = prior.expired.size;
		for (const alias of may) prior.may.add(alias);
		for (const alias of expired) prior.expired.add(alias);
		for (const alias of prior.must) if (!must.has(alias)) prior.must.delete(alias);
		if (
			prior.may.size !== beforeMay ||
			prior.must.size !== beforeMust ||
			prior.expired.size !== beforeExpired
		)
			pending.push(ip);
	};
	const initial = producerIp < 0 ? new Set([result]) : new Set<number>();
	add(0, initial, initial, new Set());
	while (pending.length > 0) {
		const ip = pending.pop()!;
		const instruction = instructions[ip]!;
		const aliases = incoming.get(ip)!;
		const handler = exceptionTargets[ip];
		if (handler !== undefined) add(handler, aliases.may, aliases.must, aliases.expired);
		const may = new Set(aliases.may),
			must = new Set(aliases.must),
			expired = new Set(aliases.expired);
		const moveMay = instruction.opcode === "MOVE" && may.has(instruction.src);
		const moveMust = instruction.opcode === "MOVE" && must.has(instruction.src);
		for (const value of vmInstructionWriteRegisters(instruction)) {
			may.delete(value);
			must.delete(value);
			expired.delete(value);
		}
		if (moveMay && instruction.opcode === "MOVE") may.add(instruction.dst);
		if (moveMust && instruction.opcode === "MOVE") must.add(instruction.dst);
		if (resetIps.has(ip)) {
			for (const alias of may) expired.add(alias);
			may.clear();
			must.clear();
		}
		if (ip === producerIp) {
			for (const alias of may) expired.add(alias);
			may.clear();
			must.clear();
			may.add(result);
			must.add(result);
		}
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF")
			add(instruction.targetIp, may, must, expired);
		if (
			instruction.opcode !== "JUMP" &&
			instruction.opcode !== "RETURN" &&
			instruction.opcode !== "THROW" &&
			instruction.opcode !== "LOAD_UNDECLARED"
		)
			add(ip + 1, may, must, expired);
	}
	return incoming;
}

export function validateNativeVirtualValue(
	instructions: ReadonlyArray<BytecodeInstruction>,
	producerIp: number,
	result: number,
	consumers: ReadonlyMap<number, ReadonlyArray<number>>,
	fail: () => never,
	transparent: (instruction: BytecodeInstruction) => boolean = () => false,
	allowMixed = false,
	resetIps: ReadonlySet<number> = new Set(),
	exceptionTargets: ReadonlyArray<number | undefined> = [],
): ReturnType<typeof nativeVirtualValueFlow> {
	const incoming = nativeVirtualValueFlow(
		instructions,
		producerIp,
		result,
		resetIps,
		exceptionTargets,
	);
	for (const [ip, aliases] of incoming) {
		const instruction = instructions[ip]!;
		if (
			vmInstructionReadRegisters(instruction).some((value) => aliases.expired.has(value))
		)
			fail();
		if (ip === producerIp) continue;
		const values = consumers.get(ip);
		if (
			values !== undefined &&
			values.some((value) => !(allowMixed ? aliases.may : aliases.must).has(value))
		)
			fail();
		const reads = vmInstructionReadRegisters(instruction).filter((value) =>
			aliases.may.has(value),
		);
		if (
			reads.length > 0 &&
			instruction.opcode !== "MOVE" &&
			instruction.opcode !== "THROW_IF_TDZ" &&
			!transparent(instruction) &&
			(values === undefined || reads.some((value) => !values.includes(value)))
		)
			fail();
	}
	for (const ip of consumers.keys()) if (!incoming.has(ip)) fail();
	return incoming;
}
