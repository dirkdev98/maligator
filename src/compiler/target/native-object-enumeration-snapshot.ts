import { COMPILER_VALUE_KIND_NUMBER } from "../shared/compiler-value-kinds.ts";
import {
	instructionInputIntegerRange,
	instructionInputKind,
} from "../shared/instruction-facts.ts";
import { stringConstantEquals } from "../shared/string-constant.ts";
import type { NativeBodyFacts } from "./native-body-facts.ts";
import { bytecodeDominates, singleWriters } from "./native-body-facts.ts";
import {
	nativeVirtualValueFlow,
	validateNativeVirtualValue,
} from "./native-virtual-value.ts";
import type { NativeFunctionPlan } from "./program-image.ts";

export const NATIVE_ENUMERATION_SNAPSHOT_CAPACITY = 16;
export const NATIVE_ENUMERATION_ENTRY_FIELD_CAPACITY = 8;
export const NATIVE_ENUMERATION_SNAPSHOT_KINDS = [
	"keys",
	"values",
	"entries",
	"names",
	"symbols",
	"own_keys",
] as const;

export interface NativeObjectEnumerationSnapshotPlan {
	readonly callIp: number;
	readonly kind: (typeof NATIVE_ENUMERATION_SNAPSHOT_KINDS)[number];
	readonly lengthIps: ReadonlyArray<number>;
	readonly elementIps: ReadonlyArray<number>;
	readonly entryProjections: ReadonlyArray<{
		readonly elementIp: number;
		readonly fields: ReadonlyArray<{
			readonly ip: number;
			readonly field: 0 | 1;
		}>;
	}>;
	readonly claimedIps: ReadonlyArray<number>;
	readonly borrowedRegisters: ReadonlyArray<number>;
	readonly fallback: "original-instructions";
}

function entryProjection(
	native: NativeFunctionPlan,
	body: NativeBodyFacts,
	callIp: number,
	elementIp: number,
	strings: ReadonlyArray<ReadonlyArray<number>>,
	unavailable: (ip: number) => boolean,
): NativeObjectEnumerationSnapshotPlan["entryProjections"][number] | undefined {
	const fn = native.body,
		producer = fn.instructions[elementIp];
	if (producer?.opcode !== "LOAD_PROPERTY" || fn.instructions.length > 512)
		return undefined;
	const resets = new Set([callIp]);
	const flow = nativeVirtualValueFlow(
		fn.instructions,
		elementIp,
		producer.dst,
		resets,
		body.handlerTargets,
		body,
	);
	const fields: Array<{ ip: number; field: 0 | 1 }> = [];
	const consumers = new Map<number, ReadonlyArray<number>>();
	const writers = singleWriters(body);
	for (const [ip, aliases] of flow) {
		if (
			aliases.may.size > 0 &&
			(body.handlerTargets[ip] !== undefined || body.handlerEntries.has(ip))
		)
			return undefined;
		if (ip === elementIp) continue;
		const op = fn.instructions[ip]!;
		const reads = body.reads[ip]!.filter((register) => aliases.may.has(register));
		if (reads.length === 0 || op.opcode === "MOVE" || op.opcode === "THROW_IF_TDZ")
			continue;
		if (reads.length !== 1 || !aliases.must.has(reads[0]!) || unavailable(ip))
			return undefined;
		let field: 0 | 1 | undefined;
		if (op.opcode === "LOAD_PROPERTY" && op.object === reads[0]) {
			const writerIp = writers.get(op.key);
			const writer = writerIp === undefined ? undefined : fn.instructions[writerIp];
			const range = instructionInputIntegerRange(native.facts?.[ip], op.key);
			const representation = native.registerRepresentations[op.key];
			if (
				writer?.opcode === "CREATE_NUMBER" &&
				(writer.value === 0 || writer.value === 1) &&
				bytecodeDominates(fn, body, writerIp!, ip)
			)
				field = writer.value;
			else if (
				(representation === "int32" ||
					representation === "number" ||
					instructionInputKind(native.facts?.[ip], op.key) ===
						COMPILER_VALUE_KIND_NUMBER) &&
				range !== undefined &&
				range.minimum === range.maximum &&
				(range.minimum === 0 || range.minimum === 1)
			)
				field = range.minimum;
		} else if (op.opcode === "LOAD_PROPERTY_STATIC" && op.object === reads[0]) {
			if (stringConstantEquals(strings[op.stringIndex], "0")) field = 0;
			else if (stringConstantEquals(strings[op.stringIndex], "1")) field = 1;
		}
		if (field === undefined || fields.length === NATIVE_ENUMERATION_ENTRY_FIELD_CAPACITY)
			return undefined;
		fields.push({ ip, field });
		consumers.set(ip, reads);
	}
	if (fields.length === 0) return undefined;
	try {
		validateNativeVirtualValue(
			fn.instructions,
			elementIp,
			producer.dst,
			consumers,
			() => {
				throw new RangeError("Observed enumeration pair");
			},
			undefined,
			false,
			resets,
			body.handlerTargets,
			body,
		);
	} catch (error) {
		if (!(error instanceof RangeError)) throw error;
		return undefined;
	}
	return {
		elementIp,
		fields: fields.sort((left, right) => left.ip - right.ip),
	};
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
		fn.profileSiteIds !== undefined ||
		fn.instructions.length > 4096
	)
		return plans;
	const named = (index: number, name: string): boolean =>
		stringConstantEquals(strings[index], name);
	let candidates = 0;
	for (const ip of body.callIps) {
		const call = fn.instructions[ip]!;
		if (plans.length === 8) break;
		if (
			(call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN") ||
			call.arguments.length === 0 ||
			body.projection?.unreachable.has(ip) ||
			body.handlerTargets[ip] !== undefined ||
			unavailable(ip)
		)
			continue;
		let kind: NativeObjectEnumerationSnapshotPlan["kind"] | undefined;
		if (call.opcode === "CALL_KNOWN") {
			if (call.construct || call.argumentMode !== undefined) continue;
			switch (call.operation) {
				case "Object.keys":
					kind = "keys";
					break;
				case "Object.values":
					kind = "values";
					break;
				case "Object.entries":
					kind = "entries";
					break;
				case "Object.getOwnPropertyNames":
					kind = "names";
					break;
				case "Reflect.ownKeys":
					kind = "own_keys";
					break;
				case "Object.getOwnPropertySymbols":
					kind = "symbols";
					break;
				default:
					continue;
			}
		}
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
					else if (named(op.stringIndex, "entries")) kind = "entries";
					else if (named(op.stringIndex, "getOwnPropertyNames")) kind = "names";
					else if (named(op.stringIndex, "getOwnPropertySymbols")) kind = "symbols";
					else if (named(op.stringIndex, "ownKeys")) kind = "own_keys";
				}
				break;
			}
		}
		if (kind === undefined) continue;
		// Rejected escapes also incur a whole-function lifetime analysis.
		if (candidates++ === 16) break;
		const flow = nativeVirtualValueFlow(
			fn.instructions,
			ip,
			call.dst,
			undefined,
			body.handlerTargets,
			body,
		);
		const consumers = new Map<number, ReadonlyArray<number>>();
		const lengthIps: Array<number> = [],
			elementIps: Array<number> = [];
		let safe = true;
		for (const [consumerIp, aliases] of flow) {
			if (
				aliases.may.size > 0 &&
				(body.handlerTargets[consumerIp] !== undefined ||
					body.handlerEntries.has(consumerIp))
			) {
				safe = false;
				break;
			}
			if (consumerIp === ip) continue;
			const op = fn.instructions[consumerIp]!;
			const reads = body.reads[consumerIp]!.filter((r) => aliases.may.has(r));
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
			validateNativeVirtualValue(
				fn.instructions,
				ip,
				call.dst,
				consumers,
				() => {
					throw new RangeError("Observed enumeration array");
				},
				undefined,
				false,
				undefined,
				body.handlerTargets,
				body,
			);
		} catch (error) {
			if (!(error instanceof RangeError)) throw error;
			continue;
		}
		lengthIps.sort((a, b) => a - b);
		elementIps.sort((a, b) => a - b);
		// A second indexed observation can materialize or mutate the same cached pair.
		const projection =
			kind === "entries" && elementIps.length === 1
				? entryProjection(native, body, ip, elementIps[0]!, strings, unavailable)
				: undefined;
		plans.push({
			callIp: ip,
			kind,
			lengthIps,
			elementIps,
			entryProjections: projection === undefined ? [] : [projection],
			claimedIps: [
				ip,
				...consumers.keys(),
				...(projection?.fields.map((field) => field.ip) ?? []),
			].sort((a, b) => a - b),
			borrowedRegisters: [],
			fallback: "original-instructions",
		});
	}
	return plans;
}
