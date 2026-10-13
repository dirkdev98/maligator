import { ARRAY_INITIALIZATION_LIMITS } from "../shared/array-initialization.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import type { NativeFunctionPlan } from "./program-image.ts";
import { decodeVmValueOperand } from "./runtime-image.ts";

export interface NativeArrayInitialization {
	readonly allocationIp: number;
	readonly mode: "prepared" | "incremental";
	readonly stores: ReadonlyArray<number>;
	readonly values: ReadonlyArray<number>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
}

function initializationStringKey(
	strings: ReadonlyArray<ReadonlyArray<number>>,
	index: number,
): string | undefined {
	const value = strings[index];
	return value !== undefined &&
		value.length <=
			String(ARRAY_INITIALIZATION_LIMITS.maximumIncrementalLength - 1).length
		? String.fromCharCode(...value)
		: undefined;
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
		fn.isAsync ||
		fn.isGenerator ||
		fn.profileSiteIds !== undefined ||
		fn.instructions.length > ARRAY_INITIALIZATION_LIMITS.maximumFunctionInstructions
	)
		return plans;
	let attempted = 0;
	for (const [allocationIp, allocation] of fn.instructions.entries()) {
		if (
			allocation.opcode !== "CREATE_ARRAY" ||
			allocation.length < 2 ||
			allocation.length > ARRAY_INITIALIZATION_LIMITS.maximumIncrementalLength ||
			unavailable(allocationIp)
		)
			continue;
		if (++attempted > ARRAY_INITIALIZATION_LIMITS.maximumCandidates) break;
		const handlerTarget = body.handlerTargets[allocationIp],
			keys = new Map<number, string>(),
			writes = new Set([allocation.dst]);
		let preparedKeys: Map<number, string> | undefined;
		const preparedKey = (register: number): string | undefined => {
			if (writes.has(register) || body.jumpTargets.has(allocationIp)) return undefined;
			if (preparedKeys === undefined) {
				preparedKeys = new Map();
				const seen = new Set<number>();
				for (
					let ip = allocationIp - 1;
					ip >=
					Math.max(
						0,
						allocationIp - ARRAY_INITIALIZATION_LIMITS.maximumPreparedKeyInstructions,
					);
					ip--
				) {
					const op = fn.instructions[ip]!;
					if (
						body.handlerTargets[ip] !== handlerTarget ||
						op.opcode === "JUMP" ||
						op.opcode === "JUMP_IF" ||
						op.opcode === "RETURN" ||
						op.opcode === "THROW" ||
						op.opcode === "YIELD" ||
						op.opcode === "AWAIT"
					)
						break;
					for (const written of body.writes[ip]!) {
						if (seen.has(written)) continue;
						seen.add(written);
						if (op.opcode === "CREATE_STRING") {
							const key = initializationStringKey(strings, op.stringIndex);
							if (key !== undefined) preparedKeys.set(written, key);
						} else if (op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64")
							preparedKeys.set(written, String(op.value));
					}
					if (body.jumpTargets.has(ip)) break;
				}
			}
			return preparedKeys.get(register);
		};
		const values: Array<number> = [],
			stores: Array<number> = [];
		for (
			let ip = allocationIp + 1;
			allocation.length <= ARRAY_INITIALIZATION_LIMITS.maximumLength &&
			ip <
				Math.min(
					fn.instructions.length,
					allocationIp + 1 + ARRAY_INITIALIZATION_LIMITS.maximumInitializerInstructions,
				);
			ip++
		) {
			if (
				body.handlerTargets[ip] !== handlerTarget ||
				body.jumpTargets.has(ip) ||
				unavailable(ip)
			)
				break;
			const op = fn.instructions[ip]!;
			if (
				op.opcode === "CREATE_STRING" ||
				op.opcode === "CREATE_NUMBER" ||
				op.opcode === "CREATE_F64"
			) {
				const key =
					op.opcode === "CREATE_STRING"
						? initializationStringKey(strings, op.stringIndex)
						: String(op.value);
				if (key === undefined) keys.delete(op.dst);
				else keys.set(op.dst, key);
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
					? initializationStringKey(strings, key.index)
					: key.kind === "number"
						? String(key.value)
						: key.kind === "register"
							? (keys.get(key.register) ?? preparedKey(key.register))
							: undefined;
			if (property !== String(values.length)) break;

			stores.push(ip);
			values.push(op.value);
			if (values.length === allocation.length) {
				plans.push({
					allocationIp,
					mode: "prepared",
					stores,
					values,
					claimedIps: [allocationIp, ...stores],
					borrowedRegisters: [],
				});
				break;
			}
		}
		if (plans.at(-1)?.allocationIp === allocationIp) continue;
		// An exceptional successor could observe a partially initialized length.
		if (handlerTarget !== undefined) continue;
		keys.clear();
		writes.clear();
		writes.add(allocation.dst);
		values.length = 0;
		stores.length = 0;
		for (
			let ip = allocationIp + 1;
			ip <
			Math.min(
				fn.instructions.length,
				allocationIp + 1 + ARRAY_INITIALIZATION_LIMITS.maximumIncrementalInstructions,
			);
			ip++
		) {
			const op = fn.instructions[ip]!;
			if (
				body.handlerTargets[ip] !== handlerTarget ||
				body.jumpTargets.has(ip) ||
				body.writes[ip]!.includes(allocation.dst) ||
				["JUMP", "JUMP_IF", "RETURN", "THROW", "YIELD", "AWAIT"].includes(op.opcode)
			)
				break;
			if (op.opcode === "DEFINE_PROPERTY" && op.object === allocation.dst) {
				if (
					!op.enumerable ||
					!op.writable ||
					!op.configurable ||
					op.value === allocation.dst ||
					unavailable(ip)
				)
					break;
				const key = decodeVmValueOperand(op.key);
				const property =
					key.kind === "string"
						? initializationStringKey(strings, key.index)
						: key.kind === "number"
							? String(key.value)
							: key.kind === "register"
								? (keys.get(key.register) ?? preparedKey(key.register))
								: undefined;
				if (property !== String(values.length)) break;
				stores.push(ip);
				values.push(op.value);
				if (values.length === allocation.length) {
					plans.push({
						allocationIp,
						mode: "incremental",
						stores,
						values,
						claimedIps: [allocationIp, ...stores],
						borrowedRegisters: [],
					});
					break;
				}
			} else {
				// Effects may collect or throw, but cannot observe this unpublished Array.
				if (body.reads[ip]!.includes(allocation.dst)) break;
				for (const register of body.writes[ip]!) {
					keys.delete(register);
					writes.add(register);
				}
				if (op.opcode === "CREATE_STRING") {
					const key = initializationStringKey(strings, op.stringIndex);
					if (key !== undefined) keys.set(op.dst, key);
				} else if (op.opcode === "CREATE_NUMBER" || op.opcode === "CREATE_F64")
					keys.set(op.dst, String(op.value));
			}
		}
	}
	return plans;
}
