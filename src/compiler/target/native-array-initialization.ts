import { ARRAY_INITIALIZATION_LIMITS } from "../shared/array-initialization.ts";
import {
	bytecodeDominates,
	nativeBodyLinearFlow,
	singleWriters,
} from "./native-body-facts.ts";
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
	let flow: ReturnType<typeof nativeBodyLinearFlow> | undefined;
	const projected = body.projection !== undefined;
	const next = (ip: number) =>
		projected
			? (flow ??= nativeBodyLinearFlow(fn, body)).next(ip)
			: ip + 1 < fn.instructions.length
				? ip + 1
				: undefined;
	const previous = (ip: number) =>
		projected
			? (flow ??= nativeBodyLinearFlow(fn, body)).previous(ip)
			: ip > 0
				? ip - 1
				: undefined;
	const transparentControl = (ip: number) =>
		projected &&
		(fn.instructions[ip]!.opcode === "JUMP" || body.projection.branches.has(ip));
	let attempted = 0;
	for (const [allocationIp, allocation] of fn.instructions.entries()) {
		if (
			allocation.opcode !== "CREATE_ARRAY" ||
			body.projection?.unreachable.has(allocationIp) ||
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
			if (writes.has(register) || (!projected && body.jumpTargets.has(allocationIp)))
				return undefined;
			if (preparedKeys === undefined) {
				preparedKeys = new Map();
				const seen = new Set<number>();
				const visited = new Set<number>();
				for (
					let ip = previous(allocationIp), steps = 0;
					ip !== undefined &&
					steps < ARRAY_INITIALIZATION_LIMITS.maximumPreparedKeyInstructions &&
					!visited.has(ip);
					ip = previous(ip), steps++
				) {
					visited.add(ip);
					const op = fn.instructions[ip]!;
					if (body.handlerTargets[ip] !== handlerTarget) break;
					if (transparentControl(ip)) {
						if (unavailable(ip)) break;
						continue;
					}
					if (
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
					if (!projected && body.jumpTargets.has(ip)) break;
				}
			}
			return preparedKeys.get(register);
		};
		// Loop-invariant code motion hoists constant keys out of loops. A register whose only
		// write is a constant that runs before this allocation on every path holds that key
		// at each store the walks below reach from it.
		const dominatingKeys = new Map<number, string | undefined>();
		const dominatingKey = (register: number): string | undefined => {
			if (dominatingKeys.has(register)) return dominatingKeys.get(register);
			const writerIp =
				register >= fn.parameterCount ? singleWriters(body).get(register) : undefined;
			const writer = writerIp === undefined ? undefined : fn.instructions[writerIp];
			const key =
				writer === undefined || !bytecodeDominates(fn, body, writerIp!, allocationIp)
					? undefined
					: writer.opcode === "CREATE_STRING"
						? initializationStringKey(strings, writer.stringIndex)
						: writer.opcode === "CREATE_NUMBER" || writer.opcode === "CREATE_F64"
							? String(writer.value)
							: undefined;
			dominatingKeys.set(register, key);
			return key;
		};
		const storeKey = (operand: number): string | undefined => {
			const key = decodeVmValueOperand(operand);
			if (key.kind === "string") return initializationStringKey(strings, key.index);
			if (key.kind === "number") return String(key.value);
			return key.kind === "register"
				? (keys.get(key.register) ??
						preparedKey(key.register) ??
						dominatingKey(key.register))
				: undefined;
		};
		const values: Array<number> = [],
			stores: Array<number> = [];
		const visited = new Set<number>([allocationIp]);
		for (
			let ip = next(allocationIp), steps = 0;
			allocation.length <= ARRAY_INITIALIZATION_LIMITS.maximumLength &&
			ip !== undefined &&
			steps < ARRAY_INITIALIZATION_LIMITS.maximumInitializerInstructions &&
			!visited.has(ip);
			ip = next(ip), steps++
		) {
			visited.add(ip);
			if (
				body.handlerTargets[ip] !== handlerTarget ||
				(!projected && body.jumpTargets.has(ip)) ||
				unavailable(ip)
			)
				break;
			const op = fn.instructions[ip]!;
			if (transparentControl(ip)) continue;
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
			if (storeKey(op.key) !== String(values.length)) break;
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
		visited.clear();
		visited.add(allocationIp);
		for (
			let ip = next(allocationIp), steps = 0;
			ip !== undefined &&
			steps < ARRAY_INITIALIZATION_LIMITS.maximumIncrementalInstructions &&
			!visited.has(ip);
			ip = next(ip), steps++
		) {
			visited.add(ip);
			const op = fn.instructions[ip]!;
			const control = transparentControl(ip);
			if (
				body.handlerTargets[ip] !== handlerTarget ||
				(!projected && body.jumpTargets.has(ip)) ||
				body.writes[ip]!.includes(allocation.dst) ||
				(!control &&
					["JUMP", "JUMP_IF", "RETURN", "THROW", "YIELD", "AWAIT"].includes(op.opcode))
			)
				break;
			if (control) {
				if (unavailable(ip)) break;
				continue;
			}
			if (op.opcode === "DEFINE_PROPERTY" && op.object === allocation.dst) {
				if (
					!op.enumerable ||
					!op.writable ||
					!op.configurable ||
					op.value === allocation.dst ||
					unavailable(ip)
				)
					break;
				if (storeKey(op.key) !== String(values.length)) break;
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
