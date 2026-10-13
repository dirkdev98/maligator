import type { NativeBodyFacts } from "./native-body-facts.ts";
import { nativeSpanCharacterCall } from "./native-string-span.ts";
import {
	nativeVirtualValueFlow,
	validateNativeVirtualValue,
} from "./native-virtual-value.ts";
import type { NativeFunctionPlan, VmStringSpanRegion } from "./program-image.ts";
import { vmInstructionReadRegisters } from "./runtime-image.ts";

export type NativeSpanConsumer = Omit<VmStringSpanRegion["consumers"][number], "kind"> & {
	readonly kind:
		| VmStringSpanRegion["consumers"][number]["kind"]
		| "rangeProperty"
		| "rangeCall";
};

export interface NativeSpanContinuation {
	readonly producerIp: number;
	readonly sourceKind: "split" | "regexp" | "range";
	readonly rangeOperation?: "slice" | "substring";
	readonly sourceCallIp: number;
	readonly consumers: ReadonlyArray<NativeSpanConsumer>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
}

export function selectNativeSpanContinuations(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	strings: ReadonlyArray<ReadonlyArray<number>>,
	unavailable: (ip: number) => boolean,
): Array<NativeSpanContinuation> {
	const fn = native.body,
		plans: Array<NativeSpanContinuation> = [];
	if (
		native.mode !== "direct" ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.handlers.length ||
		fn.profileSiteIds !== undefined ||
		fn.instructions.length > 4096
	)
		return plans;
	const materializingObservers = new Set(
		native.specializations.flatMap((region) =>
			region.kind === "string-char-code-at-chain"
				? [region.propertyIp, region.callIp]
				: [],
		),
	);
	const children = native.specializations.filter(
		(region) => region.kind === "string-span",
	);
	const childCalls = new Map(children.map((region) => [region.callIp, region]));
	const childProperties = new Map(
		children
			.filter((region) => region.propertyIp >= 0)
			.map((region) => [region.propertyIp, region]),
	);
	const sources: Array<{
		producerIp: number;
		sourceKind: NativeSpanContinuation["sourceKind"];
		sourceCallIp: number;
		rangeOperation?: "slice" | "substring";
	}> = [];
	for (const region of native.specializations) {
		if (
			region.kind !== "string-split-projection" &&
			region.kind !== "regexp-exec-projection"
		)
			continue;
		for (const load of region.loads) {
			if ("kind" in load ? load.kind !== "element" : load.consumer !== undefined)
				continue;
			sources.push({
				producerIp: load.ip,
				sourceKind: region.kind === "string-split-projection" ? "split" : "regexp",
				sourceCallIp: region.callIp,
			});
		}
	}
	// Only certified leaf ranges can consume another virtual range; nesting cannot recursively enlarge discovery.
	if (children.length)
		for (const [ip, call] of fn.instructions.entries()) {
			if (sources.length >= 32) break;
			if (
				(call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN") ||
				call.arguments.length > 2 ||
				unavailable(ip)
			)
				continue;
			let operation: "slice" | "substring" | undefined;
			if (call.opcode === "CALL_KNOWN") {
				if (call.construct || call.argumentMode !== undefined) continue;
				operation =
					call.operation === "String.prototype.slice"
						? "slice"
						: call.operation === "String.prototype.substring"
							? "substring"
							: undefined;
			} else {
				for (let at = ip - 1; at >= Math.max(0, ip - 32); at--) {
					if (body.jumpTargets.has(at + 1) || body.externalEntries.has(at + 1)) break;
					const definition = fn.instructions[at]!;
					if (body.writes[at]!.includes(call.callee)) {
						if (
							definition.opcode === "LOAD_PROPERTY_STATIC" &&
							definition.object === call.thisValue
						) {
							const name = String.fromCharCode(
								...(strings[definition.stringIndex] ?? []),
							);
							if (name === "slice" || name === "substring") operation = name;
						}
						break;
					}
					if (body.writes[at]!.includes(call.thisValue)) break;
				}
			}
			if (operation !== undefined)
				sources.push({
					producerIp: ip,
					sourceKind: "range",
					sourceCallIp: ip,
					rangeOperation: operation,
				});
		}
	const claimed = new Set<number>();
	for (const candidate of sources.slice(0, 32)) {
		if (plans.length >= 16) return plans;
		const { producerIp, sourceKind, sourceCallIp } = candidate;
		const producer = fn.instructions[producerIp];
		if (producer === undefined || !("dst" in producer)) continue;
		const reset = new Set(sourceKind === "range" ? [] : [sourceCallIp]);
		const flow = nativeVirtualValueFlow(fn.instructions, producerIp, producer.dst, reset);
		const consumers: Array<NativeSpanConsumer> = [];
		let safe = true,
			projected = false;
		for (const [ip, aliases] of flow) {
			if (ip === producerIp) continue;
			const op = fn.instructions[ip]!;
			const reads = [
				...new Set(
					vmInstructionReadRegisters(op).filter((value) => aliases.may.has(value)),
				),
			];
			if (!reads.length || op.opcode === "MOVE" || op.opcode === "THROW_IF_TDZ") continue;
			if (
				reads.length !== 1 ||
				!aliases.must.has(reads[0]!) ||
				(unavailable(ip) &&
					!materializingObservers.has(ip) &&
					!childCalls.has(ip) &&
					!childProperties.has(ip)) ||
				claimed.has(ip)
			) {
				safe = false;
				break;
			}
			const value = reads[0]!;
			const characterCall = nativeSpanCharacterCall(fn.instructions, ip, strings, body);
			const callee = fn.instructions[ip - 1];
			const numberCallee =
				op.opcode === "CALL" &&
				callee?.opcode === "LOAD_GLOBAL_PROPERTY" &&
				callee.dst === op.callee &&
				String.fromCharCode(...(strings[callee.nameStringIndex] ?? [])) === "Number";
			let kind: NativeSpanConsumer["kind"];
			if (
				childProperties.has(ip) &&
				op.opcode === "LOAD_PROPERTY_STATIC" &&
				op.object === value
			)
				kind = "rangeProperty";
			else if (
				childCalls.has(ip) &&
				(op.opcode === "CALL" || op.opcode === "CALL_KNOWN") &&
				op.thisValue === value &&
				!op.arguments.includes(value) &&
				(op.opcode !== "CALL" || op.callee !== value)
			)
				kind = "rangeCall";
			else if (
				op.opcode === "LOAD_PROPERTY_STATIC" &&
				op.object === value &&
				String.fromCharCode(...(strings[op.stringIndex] ?? [])) === "length"
			)
				kind = "length";
			else if (
				op.opcode === "LOAD_PROPERTY_STATIC" &&
				op.object === value &&
				["charCodeAt", "codePointAt"].includes(
					String.fromCharCode(...(strings[op.stringIndex] ?? [])),
				)
			)
				kind =
					String.fromCharCode(...(strings[op.stringIndex] ?? [])) === "codePointAt"
						? "codePointAtProperty"
						: "charCodeAtProperty";
			else if (
				(op.opcode === "CALL" || op.opcode === "CALL_KNOWN") &&
				op.thisValue === value &&
				op.arguments.length <= 1 &&
				op.arguments[0] !== value &&
				(op.opcode === "CALL_KNOWN"
					? characterCall !== undefined && !op.construct && op.argumentMode === undefined
					: characterCall !== undefined || materializingObservers.has(ip))
			)
				kind = characterCall ?? "charCodeAtCall";
			else if (
				(op.opcode === "CALL" || op.opcode === "CALL_KNOWN") &&
				op.arguments.length === 1 &&
				op.arguments[0] === value &&
				(numberCallee ||
					(op.opcode === "CALL_KNOWN" &&
						op.operation === "Number" &&
						!op.construct &&
						op.argumentMode === undefined))
			)
				kind = "number";
			else if (
				op.opcode === "BINARY" &&
				(op.operator === "===" || op.operator === "!==") &&
				op.left !== op.right
			)
				kind = "equal";
			else kind = "materialize";
			if (
				(childCalls.has(ip) && kind !== "rangeCall") ||
				(childProperties.has(ip) && kind !== "rangeProperty")
			) {
				safe = false;
				break;
			}
			consumers.push({ ip, value, kind });
			projected ||= kind !== "materialize";
		}
		if (
			!safe ||
			!projected ||
			consumers.length > 16 ||
			(sourceKind === "range" &&
				!consumers.some((consumer) => consumer.kind === "rangeCall"))
		)
			continue;
		try {
			validateNativeVirtualValue(
				fn.instructions,
				producerIp,
				producer.dst,
				new Map(consumers.map((consumer) => [consumer.ip, [consumer.value]])),
				() => {
					throw new RangeError("Invalid span continuation");
				},
				undefined,
				false,
				reset,
			);
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			continue;
		}
		consumers.sort((a, b) => a.ip - b.ip);
		const claimedIps = [producerIp, ...consumers.map((consumer) => consumer.ip)];
		for (const ip of claimedIps) claimed.add(ip);
		plans.push({
			...candidate,
			consumers,
			claimedIps,
			borrowedRegisters: [],
		});
	}
	return plans;
}
