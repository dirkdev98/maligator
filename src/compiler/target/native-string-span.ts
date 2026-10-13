import type { VmStringSpanRegion } from "./program-image.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeInstruction } from "./runtime-image.ts";

export function validateNativeStringSpan(
	instructions: ReadonlyArray<BytecodeInstruction>,
	region: VmStringSpanRegion,
	strings: ReadonlyArray<ReadonlyArray<number>>,
): void {
	function fail(): never {
		throw new RangeError("Invalid string-span region");
	}
	const producer = instructions[region.sliceCallIp];
	if (producer?.opcode !== "CALL" && producer?.opcode !== "CALL_KNOWN") fail();
	const property = instructions[region.propertyIp];
	if (
		(producer.opcode === "CALL_KNOWN" &&
			(producer.construct || producer.argumentMode !== undefined)) ||
		producer.arguments.length > 2 ||
		producer.thisValue !== region.receiver ||
		region.propertyPlacement !== "in-place" ||
		(producer.opcode === "CALL_KNOWN"
			? producer.operation !== "String.prototype.slice" || region.propertyIp !== -1
			: property?.opcode !== "LOAD_PROPERTY_STATIC" ||
				String.fromCharCode(...(strings[property.stringIndex] ?? [])) !== "slice" ||
				property.dst !== producer.callee ||
				property.object !== producer.thisValue) ||
		region.consumers.length === 0 ||
		region.consumers.length > 16 ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.sliceCallIp ||
		region.anchors[1] !== region.consumers[0]!.ip ||
		!region.resultRegisters.includes(producer.dst)
	)
		fail();
	const consumers = new Map(region.consumers.map((consumer) => [consumer.ip, consumer]));
	const payload = new Set(
		[region.propertyIp, region.sliceCallIp, ...consumers.keys()].filter((ip) => ip >= 0),
	);
	if (
		consumers.size !== region.consumers.length ||
		payload.size !== region.claimedIps.length ||
		region.cost.metadataOperations !== payload.size ||
		region.claimedIps.some((ip) => !payload.has(ip))
	)
		fail();
	for (const consumer of region.consumers) {
		const instruction = instructions[consumer.ip];
		if (
			instruction === undefined ||
			!region.resultRegisters.includes(consumer.value) ||
			!vmInstructionReadRegisters(instruction).includes(consumer.value)
		)
			fail();
		if (
			consumer.kind === "length" &&
			(instruction.opcode !== "LOAD_PROPERTY_STATIC" ||
				instruction.object !== consumer.value ||
				String.fromCharCode(...(strings[instruction.stringIndex] ?? [])) !== "length")
		)
			fail();
		if (
			consumer.kind === "equal" &&
			(instruction.opcode !== "BINARY" ||
				(instruction.operator !== "===" && instruction.operator !== "!=="))
		)
			fail();
		if (
			consumer.kind === "number" &&
			((instruction.opcode !== "CALL" && instruction.opcode !== "CALL_KNOWN") ||
				(instruction.opcode === "CALL_KNOWN" &&
					(instruction.construct || instruction.argumentMode !== undefined)) ||
				instruction.arguments.length !== 1 ||
				instruction.arguments[0] !== consumer.value ||
				(instruction.opcode === "CALL_KNOWN" && instruction.operation !== "Number"))
		)
			fail();
	}
	// Union and intersection distinguish a live virtual alias from a register reused on one incoming path.
	const incoming = new Map<number, { may: Set<number>; must: Set<number> }>();
	const pending: Array<number> = [];
	const add = (ip: number, may: ReadonlySet<number>, must: ReadonlySet<number>): void => {
		if (ip < 0 || ip >= instructions.length) return;
		const prior = incoming.get(ip);
		if (prior === undefined) {
			incoming.set(ip, { may: new Set(may), must: new Set(must) });
			pending.push(ip);
			return;
		}
		const beforeMay = prior.may.size,
			beforeMust = prior.must.size;
		for (const alias of may) prior.may.add(alias);
		for (const alias of prior.must) if (!must.has(alias)) prior.must.delete(alias);
		if (prior.may.size !== beforeMay || prior.must.size !== beforeMust) pending.push(ip);
	};
	add(0, new Set(), new Set());
	while (pending.length > 0) {
		const ip = pending.pop()!;
		const instruction = instructions[ip]!;
		const aliases = incoming.get(ip)!;
		const may = new Set(aliases.may),
			must = new Set(aliases.must);
		const moveMay = instruction.opcode === "MOVE" && may.has(instruction.src);
		const moveMust = instruction.opcode === "MOVE" && must.has(instruction.src);
		for (const value of vmInstructionWriteRegisters(instruction)) {
			may.delete(value);
			must.delete(value);
		}
		if (moveMay && instruction.opcode === "MOVE") may.add(instruction.dst);
		if (moveMust && instruction.opcode === "MOVE") must.add(instruction.dst);
		if (ip === region.sliceCallIp) {
			may.clear();
			must.clear();
			may.add(producer.dst);
			must.add(producer.dst);
		}
		if (instruction.opcode === "JUMP" || instruction.opcode === "JUMP_IF")
			add(instruction.targetIp, may, must);
		if (
			instruction.opcode !== "JUMP" &&
			instruction.opcode !== "RETURN" &&
			instruction.opcode !== "THROW" &&
			instruction.opcode !== "LOAD_UNDECLARED"
		)
			add(ip + 1, may, must);
	}
	for (const [ip, aliases] of incoming) {
		if (ip === region.sliceCallIp) continue;
		const instruction = instructions[ip]!;
		const consumer = consumers.get(ip);
		if (consumer !== undefined && !aliases.must.has(consumer.value)) fail();
		const reads = vmInstructionReadRegisters(instruction).filter((value) =>
			aliases.may.has(value),
		);
		if (
			reads.length > 0 &&
			instruction.opcode !== "MOVE" &&
			instruction.opcode !== "THROW_IF_TDZ" &&
			(consumer === undefined || reads.some((value) => value !== consumer.value))
		)
			fail();
	}
	for (const consumer of region.consumers) if (!incoming.has(consumer.ip)) fail();
}
