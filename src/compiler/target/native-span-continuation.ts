import {
	nativeVirtualValueFlow,
	validateNativeVirtualValue,
} from "./native-virtual-value.ts";
import type { NativeFunctionPlan, VmStringSpanRegion } from "./program-image.ts";
import { vmInstructionReadRegisters } from "./runtime-image.ts";

export interface NativeSpanContinuation {
	readonly producerIp: number;
	readonly splitCallIp: number;
	readonly consumers: VmStringSpanRegion["consumers"];
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
}

export function selectNativeSpanContinuations(
	native: NativeFunctionPlan,
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
	const claimed = new Set<number>();
	for (const region of native.specializations) {
		if (region.kind !== "string-split-projection") continue;
		for (const load of region.loads) {
			if (plans.length >= 16) return plans;
			if (load.kind !== "element") continue;
			const producer = fn.instructions[load.ip];
			if (producer === undefined || !("dst" in producer)) continue;
			const reset = new Set([region.callIp]);
			const flow = nativeVirtualValueFlow(fn.instructions, load.ip, producer.dst, reset);
			const consumers: Array<VmStringSpanRegion["consumers"][number]> = [];
			let safe = true,
				projected = false;
			for (const [ip, aliases] of flow) {
				if (ip === load.ip) continue;
				const op = fn.instructions[ip]!;
				const reads = [
					...new Set(
						vmInstructionReadRegisters(op).filter((value) => aliases.may.has(value)),
					),
				];
				if (!reads.length || op.opcode === "MOVE" || op.opcode === "THROW_IF_TDZ")
					continue;
				if (
					reads.length !== 1 ||
					!aliases.must.has(reads[0]!) ||
					(unavailable(ip) && !materializingObservers.has(ip)) ||
					claimed.has(ip)
				) {
					safe = false;
					break;
				}
				const value = reads[0]!;
				let kind: VmStringSpanRegion["consumers"][number]["kind"];
				if (
					op.opcode === "LOAD_PROPERTY_STATIC" &&
					op.object === value &&
					String.fromCharCode(...(strings[op.stringIndex] ?? [])) === "length"
				)
					kind = "length";
				else if (
					op.opcode === "BINARY" &&
					(op.operator === "===" || op.operator === "!==") &&
					op.left !== op.right
				)
					kind = "equal";
				else kind = "materialize";
				consumers.push({ ip, value, kind });
				projected ||= kind !== "materialize";
			}
			if (!safe || !projected || consumers.length > 16) continue;
			try {
				validateNativeVirtualValue(
					fn.instructions,
					load.ip,
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
			const claimedIps = [load.ip, ...consumers.map((consumer) => consumer.ip)];
			for (const ip of claimedIps) claimed.add(ip);
			plans.push({
				producerIp: load.ip,
				splitCallIp: region.callIp,
				consumers,
				claimedIps,
				borrowedRegisters: [],
			});
		}
	}
	return plans;
}
