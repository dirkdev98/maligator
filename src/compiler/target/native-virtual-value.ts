import type { NativeBodyFacts, NativeBodyProjection } from "./native-body-facts.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeInstruction } from "./runtime-image.ts";

/** The native control flow and register effects a value flow follows. */
export interface NativeVirtualValueBody {
	readonly projection?: Pick<NativeBodyProjection, "branches" | "unreachable">;
	readonly reads: NativeBodyFacts["reads"];
	readonly writes: NativeBodyFacts["writes"];
}

/** A negative `producerIp` means `result` already holds the value on entry. */
export function nativeVirtualValueFlow(
	instructions: ReadonlyArray<BytecodeInstruction>,
	producerIp: number,
	result: number,
	resetIps: ReadonlySet<number> = new Set(),
	exceptionTargets: ReadonlyArray<number | undefined> = [],
	body?: NativeVirtualValueBody,
	materializedValues: ReadonlyMap<number, ReadonlyArray<number>> = new Map(),
) {
	// Union and intersection track which registers can still hold this producer's value.
	const incoming = new Map<
		number,
		{
			may: Set<number>;
			must: Set<number>;
			expired: Set<number>;
			unmaterialized: Set<number>;
		}
	>();
	const pending: Array<number> = [];
	const add = (
		ip: number,
		may: ReadonlySet<number>,
		must: ReadonlySet<number>,
		expired: ReadonlySet<number>,
		unmaterialized: ReadonlySet<number>,
	): void => {
		if (ip < 0 || ip >= instructions.length || body?.projection?.unreachable.has(ip))
			return;
		const prior = incoming.get(ip);
		if (prior === undefined) {
			incoming.set(ip, {
				may: new Set(may),
				must: new Set(must),
				expired: new Set(expired),
				unmaterialized: new Set(unmaterialized),
			});
			pending.push(ip);
			return;
		}
		const beforeMay = prior.may.size,
			beforeMust = prior.must.size,
			beforeExpired = prior.expired.size,
			beforeUnmaterialized = prior.unmaterialized.size;
		for (const alias of may) prior.may.add(alias);
		for (const alias of expired) prior.expired.add(alias);
		for (const alias of unmaterialized) prior.unmaterialized.add(alias);
		for (const alias of prior.must) if (!must.has(alias)) prior.must.delete(alias);
		if (
			prior.may.size !== beforeMay ||
			prior.must.size !== beforeMust ||
			prior.expired.size !== beforeExpired ||
			prior.unmaterialized.size !== beforeUnmaterialized
		)
			pending.push(ip);
	};
	const initial = producerIp < 0 ? new Set([result]) : new Set<number>();
	add(0, initial, initial, new Set(), initial);
	while (pending.length > 0) {
		const ip = pending.pop()!;
		const instruction = instructions[ip]!;
		const aliases = incoming.get(ip)!;
		const handler = exceptionTargets[ip];
		if (handler !== undefined)
			add(handler, aliases.may, aliases.must, aliases.expired, aliases.unmaterialized);
		const may = new Set(aliases.may),
			must = new Set(aliases.must),
			expired = new Set(aliases.expired),
			unmaterialized = new Set(aliases.unmaterialized);
		const moveMay = instruction.opcode === "MOVE" && may.has(instruction.src);
		const moveMust = instruction.opcode === "MOVE" && must.has(instruction.src);
		const moveUnmaterialized =
			instruction.opcode === "MOVE" && unmaterialized.has(instruction.src);
		for (const value of body?.writes[ip] ?? vmInstructionWriteRegisters(instruction)) {
			may.delete(value);
			must.delete(value);
			expired.delete(value);
			unmaterialized.delete(value);
		}
		if (moveMay && instruction.opcode === "MOVE") may.add(instruction.dst);
		if (moveMust && instruction.opcode === "MOVE") must.add(instruction.dst);
		if (moveUnmaterialized && instruction.opcode === "MOVE")
			unmaterialized.add(instruction.dst);
		// Observers replace only the registers they receive with a heap copy. Other
		// aliases still refer to storage that the next producer can overwrite.
		for (const value of materializedValues.get(ip) ?? []) unmaterialized.delete(value);
		if (resetIps.has(ip)) {
			for (const alias of unmaterialized) expired.add(alias);
			may.clear();
			must.clear();
			unmaterialized.clear();
		}
		if (ip === producerIp) {
			for (const alias of unmaterialized) expired.add(alias);
			may.clear();
			must.clear();
			unmaterialized.clear();
			may.add(result);
			must.add(result);
			unmaterialized.add(result);
		}
		const target = body?.projection?.branches.get(ip);
		if (target !== undefined) {
			add(target, may, must, expired, unmaterialized);
			continue;
		}
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF")
			add(instruction.targetIp, may, must, expired, unmaterialized);
		if (
			instruction.opcode !== "JUMP" &&
			instruction.opcode !== "RETURN" &&
			instruction.opcode !== "THROW" &&
			instruction.opcode !== "LOAD_UNDECLARED"
		)
			add(ip + 1, may, must, expired, unmaterialized);
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
	body?: NativeVirtualValueBody,
	materializedValues: ReadonlyMap<number, ReadonlyArray<number>> = new Map(),
): ReturnType<typeof nativeVirtualValueFlow> {
	const incoming = nativeVirtualValueFlow(
		instructions,
		producerIp,
		result,
		resetIps,
		exceptionTargets,
		body,
		materializedValues,
	);
	for (const [ip, aliases] of incoming) {
		const instruction = instructions[ip]!;
		const operands = body?.reads[ip] ?? vmInstructionReadRegisters(instruction);
		if (operands.some((value) => aliases.expired.has(value))) fail();
		if (ip === producerIp) continue;
		const values = consumers.get(ip);
		if (
			values !== undefined &&
			values.some((value) => !(allowMixed ? aliases.may : aliases.must).has(value))
		)
			fail();
		const reads = operands.filter((value) => aliases.may.has(value));
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
