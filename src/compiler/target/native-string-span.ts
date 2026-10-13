import { validateNativeVirtualValue } from "./native-virtual-value.ts";
import type { VmStringSpanRegion } from "./program-image.ts";
import { vmInstructionReadRegisters } from "./runtime-image.ts";
import type { BytecodeInstruction } from "./runtime-image.ts";

export function validateNativeStringSpan(
	instructions: ReadonlyArray<BytecodeInstruction>,
	region: VmStringSpanRegion,
	strings: ReadonlyArray<ReadonlyArray<number>>,
): void {
	function fail(): never {
		throw new RangeError("Invalid string-span region");
	}
	const producer = instructions[region.callIp];
	if (producer?.opcode !== "CALL" && producer?.opcode !== "CALL_KNOWN") fail();
	const property = instructions[region.propertyIp];
	if (
		(region.rangeOperation !== "slice" && region.rangeOperation !== "substring") ||
		(producer.opcode === "CALL_KNOWN" &&
			(producer.construct || producer.argumentMode !== undefined)) ||
		producer.arguments.length > 2 ||
		producer.thisValue !== region.receiver ||
		region.propertyPlacement !== "in-place" ||
		(producer.opcode === "CALL_KNOWN"
			? producer.operation !== `String.prototype.${region.rangeOperation}` ||
				region.propertyIp !== -1
			: property?.opcode !== "LOAD_PROPERTY_STATIC" ||
				String.fromCharCode(...(strings[property.stringIndex] ?? [])) !==
					region.rangeOperation ||
				property.dst !== producer.callee ||
				property.object !== producer.thisValue) ||
		region.consumers.length === 0 ||
		region.consumers.length > 16 ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.callIp ||
		region.anchors[1] !== region.consumers[0]!.ip ||
		!region.resultRegisters.includes(producer.dst)
	)
		fail();
	const consumers = new Map(region.consumers.map((consumer) => [consumer.ip, consumer]));
	const payload = new Set(
		[region.propertyIp, region.callIp, ...consumers.keys()].filter((ip) => ip >= 0),
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
			consumer.kind === "charCodeAtProperty" &&
			(instruction.opcode !== "LOAD_PROPERTY_STATIC" ||
				instruction.object !== consumer.value ||
				String.fromCharCode(...(strings[instruction.stringIndex] ?? [])) !== "charCodeAt")
		)
			fail();
		if (
			consumer.kind === "charCodeAtCall" &&
			((instruction.opcode !== "CALL" && instruction.opcode !== "CALL_KNOWN") ||
				instruction.thisValue !== consumer.value ||
				instruction.arguments.length > 1 ||
				instruction.arguments[0] === consumer.value ||
				(instruction.opcode === "CALL_KNOWN" &&
					(instruction.operation !== "String.prototype.charCodeAt" ||
						instruction.construct ||
						instruction.argumentMode !== undefined)))
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
	validateNativeVirtualValue(
		instructions,
		region.callIp,
		producer.dst,
		new Map(region.consumers.map((consumer) => [consumer.ip, [consumer.value]])),
		fail,
	);
}
