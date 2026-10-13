import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { vmInstructionWriteRegisters } from "./runtime-image.ts";

export interface NativeMapEntryPlan {
	readonly getIp: number;
	readonly setIp: number;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
}

export function selectNativeMapEntries(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	unavailable: (ip: number) => boolean,
): Array<NativeMapEntryPlan> {
	const fn = native.body,
		plans: Array<NativeMapEntryPlan & { readonly receiver: string }> = [];
	if (
		native.mode !== "direct" ||
		fn.isAsync ||
		fn.isGenerator ||
		fn.profileSiteIds !== undefined ||
		fn.instructions.length > 4096
	)
		return plans;
	const pending = new Map<number, { ip: number; receiver: string }>();
	const origins = new Map<number, string>();
	for (const [ip, op] of fn.instructions.entries()) {
		if (body.handlerTargets[ip] !== undefined || body.handlerEntries.has(ip)) {
			pending.clear();
			origins.clear();
			continue;
		}
		if (body.jumpTargets.has(ip)) {
			pending.clear();
			origins.clear();
		}
		const plan = native.instructions[ip];
		const operation =
			op.opcode === "CALL_KNOWN"
				? op.operation
				: plan?.kind === "call"
					? plan.guardedBuiltinCall?.operation
					: undefined;
		if ((op.opcode === "CALL" || op.opcode === "CALL_KNOWN") && !unavailable(ip)) {
			const key = op.arguments[0];
			const receiver = origins.get(op.thisValue) ?? `register:${op.thisValue}`;
			if (
				key !== undefined &&
				operation === "Map.prototype.set" &&
				op.arguments.length === 2
			) {
				const get = pending.get(key);
				if (get !== undefined && get.receiver === receiver && ip - get.ip <= 32) {
					plans.push({
						receiver,
						getIp: get.ip,
						setIp: ip,
						claimedIps: [get.ip, ip],
						borrowedRegisters: [],
					});
					pending.delete(key);
					if (plans.length === 16) break;
				}
			} else if (
				key !== undefined &&
				operation === "Map.prototype.get" &&
				op.arguments.length === 1
			) {
				pending.set(key, { ip, receiver });
			}
		}
		const origin =
			op.opcode === "MOVE"
				? (origins.get(op.src) ?? `register:${op.src}`)
				: op.opcode === "LOAD_GLOBAL"
					? `global:${op.index}`
					: undefined;
		for (const register of vmInstructionWriteRegisters(op)) {
			origins.delete(register);
			pending.delete(register);
		}
		if (origin !== undefined && "dst" in op) origins.set(op.dst, origin);
	}
	// Adjacent get/set already reuses the owner's hint; local state pays only for overlapping lookups.
	return plans
		.filter((plan) =>
			plans.some(
				(other) =>
					other !== plan &&
					other.receiver === plan.receiver &&
					plan.getIp < other.setIp &&
					other.getIp < plan.setIp,
			),
		)
		.slice(0, 8)
		.map(({ receiver: _receiver, ...plan }) => plan);
}
