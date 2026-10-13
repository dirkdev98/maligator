import {
	nativeVirtualValueFlow,
	validateNativeVirtualValue,
} from "./native-virtual-value.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { vmInstructionReadRegisters } from "./runtime-image.ts";

export const NATIVE_KEY_SNAPSHOT_CAPACITY = 16;

export interface NativeObjectKeysSnapshotPlan {
	readonly callIp: number;
	readonly lengthIps: ReadonlyArray<number>;
	readonly elementIps: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
}

export function selectNativeObjectKeysSnapshots(
	native: NativeFunctionPlan,
	strings: ReadonlyArray<ReadonlyArray<number>>,
	unavailable: (ip: number) => boolean,
): Array<NativeObjectKeysSnapshotPlan> {
	const fn = native.body,
		plans: Array<NativeObjectKeysSnapshotPlan> = [];
	if (
		native.mode !== "direct" ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.handlers.length ||
		fn.profileSiteIds !== undefined ||
		fn.instructions.length > 4096
	)
		return plans;
	for (const [ip, call] of fn.instructions.entries()) {
		if (plans.length === 8) break;
		if (
			(call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN") ||
			(call.opcode === "CALL_KNOWN" &&
				(call.operation !== "Object.keys" ||
					call.construct ||
					call.argumentMode !== undefined)) ||
			call.arguments.length !== 1 ||
			unavailable(ip)
		)
			continue;
		if (call.opcode === "CALL") {
			const property = fn.instructions[ip - 1];
			if (
				property?.opcode !== "LOAD_PROPERTY_STATIC" ||
				property.dst !== call.callee ||
				String.fromCharCode(...(strings[property.stringIndex] ?? [])) !== "keys"
			)
				continue;
		}
		const flow = nativeVirtualValueFlow(fn.instructions, ip, call.dst);
		const consumers = new Map<number, ReadonlyArray<number>>();
		const lengthIps: Array<number> = [],
			elementIps: Array<number> = [];
		let safe = true;
		for (const [consumerIp, aliases] of flow) {
			if (consumerIp === ip) continue;
			const op = fn.instructions[consumerIp]!;
			const reads = vmInstructionReadRegisters(op).filter((r) => aliases.may.has(r));
			if (!reads.length || op.opcode === "MOVE" || op.opcode === "THROW_IF_TDZ") continue;
			if (reads.length !== 1 || !aliases.must.has(reads[0]!) || unavailable(consumerIp)) {
				safe = false;
				break;
			}
			if (
				op.opcode === "LOAD_PROPERTY_STATIC" &&
				op.object === reads[0] &&
				String.fromCharCode(...(strings[op.stringIndex] ?? [])) === "length"
			)
				lengthIps.push(consumerIp);
			else if (op.opcode === "LOAD_PROPERTY" && op.object === reads[0])
				elementIps.push(consumerIp);
			else {
				safe = false;
				break;
			}
			consumers.set(consumerIp, reads);
		}
		if (!safe || !consumers.size || consumers.size > 16) continue;
		try {
			validateNativeVirtualValue(fn.instructions, ip, call.dst, consumers, () => {
				throw new RangeError("Observed keys array");
			});
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			continue;
		}
		lengthIps.sort((a, b) => a - b);
		elementIps.sort((a, b) => a - b);
		plans.push({
			callIp: ip,
			lengthIps,
			elementIps,
			claimedIps: [ip, ...consumers.keys()].sort((a, b) => a - b),
			borrowedRegisters: [],
			fallback: "original-instructions",
		});
	}
	return plans;
}
