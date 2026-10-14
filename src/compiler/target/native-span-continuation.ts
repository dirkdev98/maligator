import type { CoreStringSpanRangeOperation } from "../core/core-ir-regions.ts";
import {
	CORE_STRING_SPAN_METHODS,
	CORE_STRING_SPAN_RANGE_METHODS,
	coreStringSpanRangeAcceptsArgumentCount,
	coreStringSpanMethodArgumentLimit,
} from "../core/core-ir-regions.ts";
import { stringConstantEquals } from "../shared/string-constant.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import { nativeSpanMethodCall, nativeSpanNumericCall } from "./native-string-span.ts";
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
	readonly rangeOperation?: CoreStringSpanRangeOperation;
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
	type Child = { callIp: number; propertyIp: number; depth: number };
	const childCalls = new Map<number, Child>(
		children.map((region) => [region.callIp, { ...region, depth: 1 }]),
	);
	const childProperties = new Map<number, Child>(
		children
			.filter((region) => region.propertyIp >= 0)
			.map((region) => [region.propertyIp, { ...region, depth: 1 }]),
	);
	type Candidate = {
		producerIp: number;
		sourceKind: NativeSpanContinuation["sourceKind"];
		sourceCallIp: number;
		rangeOperation?: CoreStringSpanRangeOperation;
		propertyIp: number;
	};
	const sources: Array<Candidate> = [];
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
				propertyIp: -1,
			});
		}
	}
	// Discovery stays bounded independently of how many admitted children a parent has.
	if (children.length)
		for (const [ip, call] of fn.instructions.entries()) {
			if (sources.length >= 32) break;
			if ((call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN") || unavailable(ip))
				continue;
			let operation: CoreStringSpanRangeOperation | undefined;
			let propertyIp = -1;
			if (call.opcode === "CALL_KNOWN") {
				if (call.construct || call.argumentMode !== undefined) continue;
				operation = CORE_STRING_SPAN_RANGE_METHODS.find(
					(method) => call.operation === `String.prototype.${method}`,
				);
			} else {
				for (let at = ip - 1; at >= Math.max(0, ip - 32); at--) {
					if (body.jumpTargets.has(at + 1) || body.externalEntries.has(at + 1)) break;
					const definition = fn.instructions[at]!;
					if (body.writes[at]!.includes(call.callee)) {
						if (
							definition.opcode === "LOAD_PROPERTY_STATIC" &&
							definition.object === call.thisValue
						) {
							const method = CORE_STRING_SPAN_RANGE_METHODS.find((method) =>
								stringConstantEquals(strings[definition.stringIndex], method),
							);
							if (method !== undefined) {
								operation = method;
								propertyIp = at;
							}
						}
						break;
					}
					if (body.writes[at]!.includes(call.thisValue)) break;
				}
			}
			if (
				operation !== undefined &&
				coreStringSpanRangeAcceptsArgumentCount(operation, call.arguments.length)
			)
				sources.push({
					producerIp: ip,
					sourceKind: "range",
					sourceCallIp: ip,
					rangeOperation: operation,
					propertyIp,
				});
		}
	const candidates = sources.slice(0, 32);
	const candidateCalls = new Map(
		candidates
			.filter((source) => source.sourceKind === "range")
			.map((source) => [source.producerIp, source]),
	);
	const candidateProperties = new Map(
		candidates
			.filter((source) => source.propertyIp >= 0)
			.map((source) => [source.propertyIp, source]),
	);
	const claimed = new Set<number>();
	const depths = new Map<number, number>();
	const attempted = new Set<number>();
	const parents = new Map<number, number>();
	// Memoization bounds lifetime analysis per candidate and rejects recursive dependency cycles.
	const admit = (candidate: Candidate): number | undefined => {
		const { producerIp, sourceKind, sourceCallIp } = candidate;
		if (attempted.has(producerIp)) return depths.get(producerIp);
		attempted.add(producerIp);
		if (plans.length >= 16) return undefined;
		const producer = fn.instructions[producerIp];
		if (
			producer === undefined ||
			!("dst" in producer) ||
			body.handlerTargets[sourceCallIp] !== undefined ||
			body.handlerTargets[producerIp] !== undefined
		)
			return undefined;
		const reset = new Set(sourceKind === "range" ? [] : [sourceCallIp]);
		const flow = nativeVirtualValueFlow(
			fn.instructions,
			producerIp,
			producer.dst,
			reset,
			body.handlerTargets,
		);
		const consumers: Array<NativeSpanConsumer> = [];
		let safe = true,
			projected = false,
			depth = 1;
		for (const [ip, aliases] of flow) {
			if (
				aliases.may.size > 0 &&
				(body.handlerTargets[ip] !== undefined || body.handlerEntries.has(ip))
			) {
				safe = false;
				break;
			}
			if (ip === producerIp) continue;
			const op = fn.instructions[ip]!;
			const reads = [
				...new Set(
					vmInstructionReadRegisters(op).filter((value) => aliases.may.has(value)),
				),
			];
			if (!reads.length || op.opcode === "MOVE" || op.opcode === "THROW_IF_TDZ") continue;
			const childCandidate = candidateCalls.get(ip) ?? candidateProperties.get(ip);
			if (childCandidate !== undefined && admit(childCandidate) === undefined) {
				safe = false;
				break;
			}
			if (
				reads.length !== 1 ||
				!aliases.must.has(reads[0]!) ||
				(unavailable(ip) &&
					!materializingObservers.has(ip) &&
					!childCalls.has(ip) &&
					!childProperties.has(ip))
			) {
				safe = false;
				break;
			}
			const value = reads[0]!;
			const methodCall = nativeSpanMethodCall(fn.instructions, ip, strings, body);
			const numericCall = nativeSpanNumericCall(fn.instructions, ip, strings, body);
			let kind: NativeSpanConsumer["kind"];
			const methodProperty =
				op.opcode === "LOAD_PROPERTY_STATIC"
					? CORE_STRING_SPAN_METHODS.find((method) =>
							stringConstantEquals(strings[op.stringIndex], method),
						)
					: undefined;
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
				stringConstantEquals(strings[op.stringIndex], "length")
			)
				kind = "length";
			else if (
				op.opcode === "LOAD_PROPERTY_STATIC" &&
				op.object === value &&
				methodProperty !== undefined
			)
				kind = `${methodProperty}Property`;
			else if (
				(op.opcode === "CALL" || op.opcode === "CALL_KNOWN") &&
				op.thisValue === value &&
				op.arguments.length <=
					(methodCall === undefined
						? 1
						: coreStringSpanMethodArgumentLimit(
								CORE_STRING_SPAN_METHODS.find(
									(method) => methodCall === `${method}Call`,
								)!,
							)) &&
				!op.arguments.includes(value) &&
				(op.opcode === "CALL_KNOWN"
					? methodCall !== undefined && !op.construct && op.argumentMode === undefined
					: methodCall !== undefined || materializingObservers.has(ip))
			)
				kind = methodCall ?? "charCodeAtCall";
			else if (
				(op.opcode === "CALL" || op.opcode === "CALL_KNOWN") &&
				numericCall !== undefined &&
				op.arguments.length >= 1 &&
				op.arguments.length <= (numericCall === "parseInt" ? 2 : 1) &&
				op.arguments[0] === value &&
				!op.arguments.slice(1).includes(value) &&
				op.thisValue !== value &&
				(op.opcode !== "CALL" || op.callee !== value) &&
				(op.opcode !== "CALL_KNOWN" || (!op.construct && op.argumentMode === undefined))
			)
				kind = numericCall;
			else if (
				op.opcode === "PREPARED_STRING_COMPARE" &&
				op.left === value &&
				op.right !== value
			)
				kind = "localeComparePrepared";
			else if (
				op.opcode === "BINARY" &&
				(op.operator === "===" || op.operator === "!==") &&
				op.left !== op.right
			)
				kind = "equal";
			else kind = "materialize";
			if (
				(claimed.has(ip) && (kind !== "rangeCall" || parents.has(ip))) ||
				(childCalls.has(ip) && kind !== "rangeCall") ||
				(childProperties.has(ip) && kind !== "rangeProperty")
			) {
				safe = false;
				break;
			}
			if (kind === "rangeCall") depth = Math.max(depth, childCalls.get(ip)!.depth + 1);
			if (depth > 4 || consumers.length >= 16) {
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
			return undefined;
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
				body.handlerTargets,
			);
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			return undefined;
		}
		if (plans.length >= 16) return undefined;
		consumers.sort((a, b) => a.ip - b.ip);
		const claimedIps = [producerIp, ...consumers.map((consumer) => consumer.ip)];
		for (const ip of claimedIps) claimed.add(ip);
		for (const consumer of consumers)
			if (consumer.kind === "rangeCall") parents.set(consumer.ip, producerIp);
		plans.push({
			producerIp,
			sourceKind,
			sourceCallIp,
			...(candidate.rangeOperation === undefined
				? {}
				: { rangeOperation: candidate.rangeOperation }),
			consumers,
			claimedIps,
			borrowedRegisters: [],
		});
		depths.set(producerIp, depth);
		if (sourceKind === "range") {
			const child = { callIp: producerIp, propertyIp: candidate.propertyIp, depth };
			childCalls.set(producerIp, child);
			if (candidate.propertyIp >= 0) childProperties.set(candidate.propertyIp, child);
		}
		return depth;
	};
	for (const candidate of candidates) admit(candidate);
	return plans;
}
