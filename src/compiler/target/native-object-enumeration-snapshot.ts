import { stringConstantEquals } from "../shared/string-constant.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import {
	nativeVirtualValueFlow,
	validateNativeVirtualValue,
} from "./native-virtual-value.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { vmInstructionReadRegisters } from "./runtime-image.ts";

export const NATIVE_ENUMERATION_SNAPSHOT_CAPACITY = 16;

export interface NativeObjectEnumerationSnapshotPlan {
	readonly callIp: number;
	readonly kind: "keys" | "values";
	readonly lengthIps: ReadonlyArray<number>;
	readonly elementIps: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
}

export function selectNativeObjectEnumerationSnapshots(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	strings: ReadonlyArray<ReadonlyArray<number>>,
	unavailable: (ip: number) => boolean,
): Array<NativeObjectEnumerationSnapshotPlan> {
	const fn = native.body,
		plans: Array<NativeObjectEnumerationSnapshotPlan> = [];
	if (
		native.mode !== "direct" ||
		fn.isGenerator ||
		fn.isAsync ||
		fn.handlers.length ||
		fn.profileSiteIds !== undefined ||
		fn.instructions.length > 4096
	)
		return plans;
	const named = (index: number, name: string): boolean =>
		stringConstantEquals(strings[index], name);
	let candidates = 0;
	for (const [ip, call] of fn.instructions.entries()) {
		if (plans.length === 8) break;
		if (
			(call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN") ||
			(call.opcode === "CALL_KNOWN" &&
				((call.operation !== "Object.keys" && call.operation !== "Object.values") ||
					call.construct ||
					call.argumentMode !== undefined)) ||
			call.arguments.length !== 1 ||
			unavailable(ip)
		)
			continue;
		let kind: "keys" | "values" | undefined =
			call.opcode === "CALL_KNOWN"
				? call.operation === "Object.keys"
					? "keys"
					: "values"
				: undefined;
		if (call.opcode === "CALL") {
			for (let prior = ip - 1; prior >= Math.max(0, ip - 16); prior--) {
				if (body.jumpTargets.has(prior + 1)) break;
				const op = fn.instructions[prior]!;
				if (
					op.opcode === "JUMP" ||
					op.opcode === "JUMP_IF" ||
					op.opcode === "RETURN" ||
					op.opcode === "THROW"
				)
					break;
				if (!body.writes[prior]!.includes(call.callee)) continue;
				// The captured callee survives argument evaluation; runtime still guards its identity.
				if (op.opcode === "LOAD_PROPERTY_STATIC") {
					if (named(op.stringIndex, "keys")) kind = "keys";
					else if (named(op.stringIndex, "values")) kind = "values";
				}
				break;
			}
		}
		if (kind === undefined) continue;
		// Rejected escapes also incur a whole-function lifetime analysis.
		if (candidates++ === 16) break;
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
				named(op.stringIndex, "length")
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
				throw new RangeError("Observed enumeration array");
			});
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			continue;
		}
		lengthIps.sort((a, b) => a - b);
		elementIps.sort((a, b) => a - b);
		plans.push({
			callIp: ip,
			kind,
			lengthIps,
			elementIps,
			claimedIps: [ip, ...consumers.keys()].sort((a, b) => a - b),
			borrowedRegisters: [],
			fallback: "original-instructions",
		});
	}
	return plans;
}
