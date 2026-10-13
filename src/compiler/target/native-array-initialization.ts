import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { decodeVmValueOperand } from "./runtime-image.ts";

export interface NativeArrayInitialization {
	readonly allocationIp: number;
	readonly stores: ReadonlyArray<number>;
	readonly values: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
}

export function selectNativeArrayInitializations(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	strings: ReadonlyArray<ReadonlyArray<number>>,
	unavailable: (ip: number) => boolean,
): Array<NativeArrayInitialization> {
	const fn = native.body,
		plans: Array<NativeArrayInitialization> = [];
	if (
		native.mode !== "direct" ||
		fn.handlers.length ||
		fn.isAsync ||
		fn.isGenerator ||
		fn.profileSiteIds !== undefined ||
		fn.instructions.length > 4096
	)
		return plans;
	for (const [allocationIp, allocation] of fn.instructions.entries()) {
		if (
			allocation.opcode !== "CREATE_ARRAY" ||
			allocation.length < 2 ||
			allocation.length > 8 ||
			unavailable(allocationIp)
		)
			continue;
		const keys = new Map<number, string>(),
			writes = new Set([allocation.dst]);
		const values: Array<number> = [],
			stores: Array<number> = [];
		for (
			let ip = allocationIp + 1;
			ip < Math.min(fn.instructions.length, allocationIp + 18);
			ip++
		) {
			if (body.jumpTargets.has(ip) || unavailable(ip)) break;
			const op = fn.instructions[ip]!;
			if (op.opcode === "CREATE_STRING" || op.opcode === "CREATE_NUMBER") {
				keys.set(
					op.dst,
					op.opcode === "CREATE_STRING"
						? String.fromCharCode(...(strings[op.stringIndex] ?? []))
						: String(op.value),
				);
				writes.add(op.dst);
				continue;
			}
			if (
				op.opcode !== "DEFINE_PROPERTY" ||
				op.object !== allocation.dst ||
				!op.enumerable ||
				!op.writable ||
				!op.configurable ||
				writes.has(op.value)
			)
				break;
			const key = decodeVmValueOperand(op.key);
			const property =
				key.kind === "string"
					? String.fromCharCode(...(strings[key.index] ?? []))
					: key.kind === "number"
						? String(key.value)
						: key.kind === "register"
							? keys.get(key.register)
							: undefined;
			if (property !== String(values.length)) break;

			stores.push(ip);
			values.push(op.value);
			if (values.length === allocation.length) {
				plans.push({
					allocationIp,
					stores,
					values,
					claimedIps: [allocationIp, ...stores],
					borrowedRegisters: [],
				});
				break;
			}
		}
		if (plans.length === 16) break;
	}
	return plans;
}
