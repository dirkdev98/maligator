import {
	CORE_STRING_SPAN_METHODS,
	CORE_STRING_SPAN_RANGE_METHODS,
	CORE_STRING_SPAN_SEARCH_METHODS,
} from "../core/core-ir-regions.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import { validateNativeVirtualValue } from "./native-virtual-value.ts";
import type { VmStringSpanRegion } from "./program-image.ts";
import {
	vmInstructionReadRegisters,
	vmInstructionWriteRegisters,
} from "./runtime-image.ts";
import type { BytecodeInstruction } from "./runtime-image.ts";

export function nativeSpanMethodCall(
	instructions: ReadonlyArray<BytecodeInstruction>,
	ip: number,
	strings: ReadonlyArray<ReadonlyArray<number>>,
	body: Pick<NativeBodyFacts, "branchSources" | "externalEntries">,
): `${(typeof CORE_STRING_SPAN_METHODS)[number]}Call` | undefined {
	const call = instructions[ip];
	if (call?.opcode === "CALL_KNOWN") {
		const method = CORE_STRING_SPAN_METHODS.find(
			(name) => call.operation === `String.prototype.${name}`,
		);
		return method === undefined ? undefined : `${method}Call`;
	}
	if (call?.opcode !== "CALL") return undefined;
	type Kind = `${(typeof CORE_STRING_SPAN_METHODS)[number]}Call`;
	const visiting = new Set<number>(),
		completed = new Map<number, Kind | undefined>();
	let work = 0;
	const visit = (use: number): Kind | undefined => {
		if (completed.has(use)) return completed.get(use);
		if (++work > 64 || visiting.has(use) || body.externalEntries.has(use))
			return undefined;
		visiting.add(use);
		const previous = instructions[use - 1];
		const predecessors = [...(body.branchSources.get(use) ?? [])];
		if (
			previous !== undefined &&
			previous.opcode !== "JUMP" &&
			previous.opcode !== "RETURN" &&
			previous.opcode !== "THROW"
		)
			predecessors.push(use - 1);
		let method: Kind | undefined;
		for (const definition of predecessors) {
			if (++work > 64) return undefined;
			const op = instructions[definition]!;
			let found: Kind | undefined;
			if (vmInstructionWriteRegisters(op).includes(call.callee)) {
				const name =
					op.opcode === "LOAD_PROPERTY_STATIC"
						? String.fromCharCode(...(strings[op.stringIndex] ?? []))
						: undefined;
				const method = CORE_STRING_SPAN_METHODS.find((value) => value === name);
				found = method === undefined ? undefined : `${method}Call`;
			} else found = visit(definition);
			if (found === undefined || (method !== undefined && method !== found))
				return undefined;
			method = found;
		}
		visiting.delete(use);
		completed.set(use, method);
		return method;
	};
	return visit(ip);
}

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
		!CORE_STRING_SPAN_RANGE_METHODS.includes(region.rangeOperation) ||
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
	let methodBody: Pick<NativeBodyFacts, "branchSources" | "externalEntries"> | undefined;
	for (const consumer of region.consumers) {
		const instruction = instructions[consumer.ip];
		const methodProperty = CORE_STRING_SPAN_METHODS.find(
			(method) => consumer.kind === `${method}Property`,
		);
		const methodCall = CORE_STRING_SPAN_METHODS.find(
			(method) => consumer.kind === `${method}Call`,
		);
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
			methodProperty !== undefined &&
			(instruction.opcode !== "LOAD_PROPERTY_STATIC" ||
				instruction.object !== consumer.value ||
				String.fromCharCode(...(strings[instruction.stringIndex] ?? [])) !==
					methodProperty)
		)
			fail();
		if (
			methodCall !== undefined &&
			((instruction.opcode !== "CALL" && instruction.opcode !== "CALL_KNOWN") ||
				instruction.thisValue !== consumer.value ||
				instruction.arguments.length >
					(CORE_STRING_SPAN_SEARCH_METHODS.some((name) => name === methodCall) ? 2 : 1) ||
				instruction.arguments.includes(consumer.value) ||
				(instruction.opcode === "CALL_KNOWN" &&
					(instruction.operation !== `String.prototype.${methodCall}` ||
						instruction.construct ||
						instruction.argumentMode !== undefined)))
		)
			fail();
		if (methodCall !== undefined) {
			if (methodBody === undefined) {
				const branchSources = new Map<number, Array<number>>();
				for (const [source, op] of instructions.entries()) {
					if (op.opcode === "JUMP" || op.opcode === "JUMP_IF") {
						const sources = branchSources.get(op.targetIp) ?? [];
						sources.push(source);
						branchSources.set(op.targetIp, sources);
					}
				}
				methodBody = {
					branchSources,
					externalEntries: new Set(region.controlFlow.exceptionalHandlerIps),
				};
			}
			const method = nativeSpanMethodCall(instructions, consumer.ip, strings, methodBody);
			if (method !== undefined && method !== consumer.kind) fail();
		}
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
