import {
	COMPILER_VALUE_KIND_BOOLEAN,
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
} from "../shared/compiler-value-kinds.ts";
import { compilerIntegerRangeIsInt32 } from "../shared/integer-range.ts";
import type { CompilerIntegerRange } from "../shared/integer-range.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import { CORE_LOOP_INDUCTION_ANALYSIS } from "./core-ir-loops.ts";
import type {
	CoreDirectEntryPlan,
	CorePlanRepresentation,
	CoreRecordLayout,
	CoreRecordUses,
} from "./core-ir-regions.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreFunctionId, CoreInstructionId } from "./core-ir.ts";
import { coreRecordResultFields } from "./core-native-field-analysis.ts";
import { CORE_PROGRAM_VALUE_KIND_ANALYSIS } from "./core-program-flow-analysis.ts";
import type { CoreProgram } from "./core-store.ts";

interface StorageNode {
	parent: number;
	rank: number;
	readonly layout: CoreRecordLayout;
	readonly masks: Array<number>;
	readonly ranges: Array<CompilerIntegerRange | null | undefined>;
}

export interface CoreRecordStorageField {
	readonly integerRange?: CompilerIntegerRange;
	readonly kindMask: number;
	readonly representation: CorePlanRepresentation;
}

export interface CoreRecordStorageWidths {
	result(entry: CoreDirectEntryPlan): ReadonlyArray<CoreRecordStorageField> | undefined;
	parameter(
		entry: CoreDirectEntryPlan,
		index: number,
	): ReadonlyArray<CoreRecordStorageField> | undefined;
	object(
		caller: CoreFunctionId,
		allocation: CoreInstructionId,
	): ReadonlyArray<CoreRecordStorageField> | undefined;
}

// Prototype methods keep the analysis manager out of the retained plan.
class CoreRecordStorageWidthIndex implements CoreRecordStorageWidths {
	readonly #results: ReadonlyMap<string, ReadonlyArray<CoreRecordStorageField>>;
	readonly #parameters: ReadonlyMap<
		string,
		ReadonlyMap<number, ReadonlyArray<CoreRecordStorageField>>
	>;
	readonly #objects: ReadonlyMap<string, ReadonlyArray<CoreRecordStorageField>>;
	constructor(
		results: ReadonlyMap<string, ReadonlyArray<CoreRecordStorageField>>,
		parameters: ReadonlyMap<
			string,
			ReadonlyMap<number, ReadonlyArray<CoreRecordStorageField>>
		>,
		objects: ReadonlyMap<string, ReadonlyArray<CoreRecordStorageField>>,
	) {
		this.#results = results;
		this.#parameters = parameters;
		this.#objects = objects;
		Object.freeze(this);
	}
	result(entry: CoreDirectEntryPlan) {
		return this.#results.get(`${entry.function}:${entry.id}`);
	}
	parameter(entry: CoreDirectEntryPlan, index: number) {
		return this.#parameters.get(`${entry.function}:${entry.id}`)?.get(index);
	}
	object(caller: CoreFunctionId, allocation: CoreInstructionId) {
		return this.#objects.get(`${caller}:${allocation}`);
	}
}

interface CoreRecordStorageProof {
	readonly program: CoreProgram;
	readonly dataVersion: number;
	readonly functionsVersion: number;
	readonly flowRevision: number;
	readonly generation: number;
	readonly entries: ReadonlyArray<CoreDirectEntryPlan>;
}

const storageProofs = new WeakMap<CoreRecordStorageWidths, CoreRecordStorageProof>();

function recordEntries(entries: ReadonlyArray<CoreDirectEntryPlan>) {
	return entries.filter(
		(entry) => entry.resultFields !== undefined || entry.recordParameters !== undefined,
	);
}

export function coreRecordStorageWidthProofIsCurrent(
	program: CoreProgram,
	entries: ReadonlyArray<CoreDirectEntryPlan>,
	widths: CoreRecordStorageWidths,
): boolean {
	const proof = storageProofs.get(widths);
	if (
		proof?.program !== program ||
		!program.sealed ||
		proof.dataVersion !== program.programVersion("data") ||
		proof.functionsVersion !== program.programVersion("functions") ||
		proof.flowRevision !== program.programFlowRevision ||
		proof.generation !== program.generation
	)
		return false;
	const selected = recordEntries(entries);
	return (
		selected.length === proof.entries.length &&
		selected.every((entry, index) => {
			const original = proof.entries[index]!;
			return (
				entry.function === original.function &&
				entry.id === original.id &&
				entry.resultFields === original.resultFields &&
				entry.recordParameters === original.recordParameters &&
				entry.instructionFacts === original.instructionFacts &&
				entry.callOverrides === original.callOverrides &&
				entry.callSites.length === original.callSites.length &&
				entry.callSites.every((site, index) => {
					const source = original.callSites[index]!;
					return (
						site.caller === source.caller &&
						site.instruction === source.instruction &&
						site.recordUses === source.recordUses &&
						site.recordObjects === source.recordObjects
					);
				})
			);
		})
	);
}

/** Storage widths cover every virtual write; observers thereafter access the materialized object. */
export function analyzeCoreRecordStorageWidths(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	entries: ReadonlyArray<CoreDirectEntryPlan>,
): CoreRecordStorageWidths {
	const nodes: Array<StorageNode> = [];
	const results = new Map<string, number>();
	const entryKey = (entry: CoreDirectEntryPlan) => `${entry.function}:${entry.id}`;
	const parameters = new Map<string, Map<number, number>>();
	const objects = new Map<string, number>();
	const supplied = new Map<string, Array<number>>();
	const entryByKey = new Map(
		entries.map((entry) => [`${entry.function}:${entry.id}`, entry]),
	);
	const objectKey = (caller: CoreFunctionId, allocation: CoreInstructionId) =>
		`${caller}:${allocation}`;
	const passKey = (
		caller: CoreFunctionId,
		call: CoreInstructionId,
		argument: number,
		target: CoreFunctionId,
	) => `${caller}:${call}:${argument}:${target}`;
	const create = (layout: CoreRecordLayout): number => {
		const index = nodes.length;
		nodes.push({
			parent: index,
			rank: 0,
			layout,
			masks: Array<number>(layout.keys.length).fill(0),
			ranges: new Array<CompilerIntegerRange | null | undefined>(layout.keys.length),
		});
		return index;
	};
	const root = (index: number): number => {
		let current = index;
		while (nodes[current]!.parent !== current) current = nodes[current]!.parent;
		while (index !== current) {
			const next = nodes[index]!.parent;
			nodes[index]!.parent = current;
			index = next;
		}
		return current;
	};
	const joinRange = (
		left: CompilerIntegerRange | null | undefined,
		right: CompilerIntegerRange | null | undefined,
	): CompilerIntegerRange | null | undefined => {
		if (left === undefined) return right;
		if (right === undefined) return left;
		if (left === null || right === null) return null;
		return {
			minimum: Math.min(left.minimum, right.minimum),
			maximum: Math.max(left.maximum, right.maximum),
			exactSafeIntegers: true,
			excludesNegativeZero: true,
		};
	};
	const include = (
		node: number,
		field: number,
		mask: number,
		range?: CompilerIntegerRange,
	): void => {
		const storage = nodes[root(node)]!;
		storage.masks[field] = storage.masks[field]! | mask;
		storage.ranges[field] = joinRange(
			storage.ranges[field],
			mask === COMPILER_VALUE_KIND_NUMBER && range !== undefined ? range : null,
		);
	};
	const join = (left: number, right: number): void => {
		left = root(left);
		right = root(right);
		if (left === right) return;
		let a = nodes[left]!,
			b = nodes[right]!;
		if (
			a.layout.keys.length !== b.layout.keys.length ||
			a.layout.keys.some((key, index) => key !== b.layout.keys[index]) ||
			(a.layout.shapes?.length ?? 0) !== (b.layout.shapes?.length ?? 0) ||
			(a.layout.shapes ?? []).some(
				(shape, index) =>
					shape.length !== b.layout.shapes![index]!.length ||
					shape.some((field, offset) => field !== b.layout.shapes![index]![offset]),
			)
		)
			throw new Error("Incompatible shared record storage layouts");
		if (a.rank < b.rank) {
			[left, right] = [right, left];
			[a, b] = [b, a];
		}
		b.parent = left;
		if (a.rank === b.rank) a.rank++;
		for (let field = 0; field < a.masks.length; field++) {
			a.masks[field] = a.masks[field]! | b.masks[field]!;
			a.ranges[field] = joinRange(a.ranges[field], b.ranges[field]);
		}
	};
	const instructionMasks = new WeakMap<
		CoreDirectEntryPlan,
		ReadonlyMap<
			CoreInstructionId,
			NonNullable<CoreDirectEntryPlan["instructionFacts"]>[number]
		>
	>();
	const inputMask = (
		functionId: CoreFunctionId,
		instruction: CoreInstructionId,
		operand: number,
		entry?: CoreDirectEntryPlan,
	): number => {
		let byInstruction = entry === undefined ? undefined : instructionMasks.get(entry);
		if (entry !== undefined && byInstruction === undefined) {
			byInstruction = new Map(
				entry.instructionFacts?.map((fact) => [fact.instruction, fact]),
			);
			instructionMasks.set(entry, byInstruction);
		}
		const exact = byInstruction?.get(instruction)?.masks[operand];
		if (exact !== undefined) return exact;
		const fn = program.function(functionId);
		const value = fn.kernel.operandAt(
			fn.kernel.instructionOperandStart(instruction) + operand,
		);
		return analyses
			.get(CORE_LOCAL_VALUE_KIND_ANALYSIS, { scope: "function", function: functionId })
			.kindMask(value);
	};
	const inputRange = (
		functionId: CoreFunctionId,
		instruction: CoreInstructionId,
		operand: number,
		entry?: CoreDirectEntryPlan,
	): CompilerIntegerRange | undefined => {
		if (inputMask(functionId, instruction, operand, entry) !== COMPILER_VALUE_KIND_NUMBER)
			return undefined;
		const fn = program.function(functionId);
		const value = fn.kernel.operandAt(
			fn.kernel.instructionOperandStart(instruction) + operand,
		);
		const local = analyses
			.get(CORE_LOOP_INDUCTION_ANALYSIS, { scope: "function", function: functionId })
			.range(value, fn.instructionBlock(instruction));
		const exact =
			entry === undefined
				? undefined
				: instructionMasks.get(entry)?.get(instruction)?.inputIntegerRanges?.[operand];
		if (local === undefined) return exact;
		if (exact === undefined) return local;
		const minimum = Math.max(local.minimum, exact.minimum),
			maximum = Math.min(local.maximum, exact.maximum);
		return minimum <= maximum
			? { minimum, maximum, exactSafeIntegers: true, excludesNegativeZero: true }
			: undefined;
	};
	const fallbackRanges = new Map<
		CoreFunctionId,
		ReadonlyMap<number, CompilerIntegerRange | null | undefined>
	>();
	const fallbackRange = (
		target: CoreFunctionId,
		key: number,
	): CompilerIntegerRange | undefined => {
		let ranges = fallbackRanges.get(target);
		if (ranges === undefined) {
			const fn = program.function(target);
			const fields = coreRecordResultFields(
				fn,
				analyses
					.get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, { scope: "function", function: target })
					.exceptional(),
			);
			if (fields === undefined) throw new Error("Invalid literal record forward target");
			const joined = new Map<number, CompilerIntegerRange | null | undefined>();
			for (const allocation of fields.allocations)
				for (const [operand, fieldKey] of fields.keys.entries())
					joined.set(
						fieldKey,
						joinRange(
							joined.get(fieldKey),
							inputRange(target, allocation, operand) ?? null,
						),
					);
			ranges = joined;
			fallbackRanges.set(target, ranges);
		}
		return ranges.get(key) ?? undefined;
	};
	const stores = (
		node: number,
		functionId: CoreFunctionId,
		uses: CoreRecordUses,
		entry?: CoreDirectEntryPlan,
	): void => {
		for (const { instruction, field } of uses.stores)
			include(
				node,
				field,
				inputMask(functionId, instruction, 1, entry),
				inputRange(functionId, instruction, 1, entry),
			);
	};
	for (const entry of entries) {
		if (entry.resultFields !== undefined)
			results.set(entryKey(entry), create(entry.resultFields));
		for (const parameter of entry.recordParameters ?? []) {
			let byIndex = parameters.get(entryKey(entry));
			if (byIndex === undefined)
				parameters.set(entryKey(entry), (byIndex = new Map<number, number>()));
			byIndex.set(parameter.index, create(parameter));
			for (const site of entry.callSites) {
				const key = passKey(
					site.caller,
					site.instruction,
					parameter.index,
					entry.function,
				);
				let nodes = supplied.get(key);
				if (nodes === undefined) supplied.set(key, (nodes = []));
				nodes.push(byIndex.get(parameter.index)!);
			}
		}
	}
	for (const entry of entries) {
		const fields = entry.resultFields;
		if (fields !== undefined) {
			const node = results.get(entryKey(entry))!;
			for (const [index, allocation] of fields.allocations.entries()) {
				const shape = fields.shapes?.[index] ?? fields.keys.map((_, field) => field);
				for (const [operand, field] of shape.entries())
					include(
						node,
						field,
						inputMask(entry.function, allocation, operand, entry),
						inputRange(entry.function, allocation, operand, entry),
					);
				for (let field = 0; field < fields.keys.length; field++)
					if (!shape.includes(field)) include(node, field, COMPILER_VALUE_KIND_UNDEFINED);
			}
			for (const forward of fields.forwards ?? []) {
				const override = entry.callOverrides?.find(
					(call) =>
						call.instruction === forward.instruction && call.target === forward.target,
				);
				const target =
					override === undefined
						? undefined
						: entryByKey.get(`${override.target}:${override.entryId}`);
				const forwarded =
					target === undefined ? undefined : results.get(entryKey(target));
				if (forwarded !== undefined) {
					join(node, forwarded);
					continue;
				}
				const record = analyses
					.get(CORE_PROGRAM_VALUE_KIND_ANALYSIS, { scope: "program" })
					.kinds.summary(forward.target).returnRecord;
				for (const [field, key] of fields.keys.entries())
					include(
						node,
						field,
						record?.find((candidate) => candidate.key === key)?.mask ??
							COMPILER_VALUE_KIND_TOP,
						fallbackRange(forward.target, key),
					);
			}
			for (const site of entry.callSites) {
				const uses = site.recordUses;
				if (uses === undefined) continue;
				stores(node, site.caller, uses);
				for (const pass of uses.passes ?? [])
					for (const target of supplied.get(
						passKey(site.caller, pass.instruction, pass.argument, pass.target),
					) ?? [])
						join(node, target);
			}
		}
		for (const parameter of entry.recordParameters ?? [])
			stores(
				parameters.get(entryKey(entry))!.get(parameter.index)!,
				entry.function,
				parameter.uses,
				entry,
			);
		for (const site of entry.callSites)
			for (const object of site.recordObjects ?? []) {
				const parameter = parameters.get(entryKey(entry))?.get(object.argument);
				if (parameter === undefined) continue;
				const key = objectKey(site.caller, object.allocation);
				let node = objects.get(key);
				if (node === undefined) {
					node = create(nodes[parameter]!.layout);
					objects.set(key, node);
					for (let field = 0; field < nodes[node]!.layout.keys.length; field++)
						include(
							node,
							field,
							inputMask(site.caller, object.allocation, field),
							inputRange(site.caller, object.allocation, field),
						);
					stores(node, site.caller, object.uses);
				}
				join(node, parameter);
			}
	}
	const widthsByRoot = new Map<number, ReadonlyArray<CoreRecordStorageField>>();
	const widths = nodes.map((_, index) => {
		const component = root(index);
		const cached = widthsByRoot.get(component);
		if (cached !== undefined) return cached;
		const storage = nodes[component]!;
		const fields = Object.freeze(
			storage.masks.map((mask, field): CoreRecordStorageField => {
				const range =
					mask === COMPILER_VALUE_KIND_NUMBER ? storage.ranges[field] : undefined;
				return Object.freeze({
					kindMask: mask || COMPILER_VALUE_KIND_TOP,
					...(range === undefined || range === null
						? {}
						: { integerRange: Object.freeze({ ...range }) }),
					representation:
						mask === COMPILER_VALUE_KIND_NUMBER
							? compilerIntegerRangeIsInt32(range ?? undefined)
								? "i32"
								: "f64"
							: mask === COMPILER_VALUE_KIND_BOOLEAN
								? "boolean"
								: mask === COMPILER_VALUE_KIND_STRING
									? "string"
									: "boxed",
				});
			}),
		);
		widthsByRoot.set(component, fields);
		return fields;
	});
	const selected = new CoreRecordStorageWidthIndex(
		new Map([...results].map(([key, node]) => [key, widths[node]!])),
		new Map(
			[...parameters].map(([key, indices]) => [
				key,
				new Map([...indices].map(([index, node]) => [index, widths[node]!])),
			]),
		),
		new Map([...objects].map(([key, node]) => [key, widths[node]!])),
	);
	storageProofs.set(selected, {
		program,
		dataVersion: program.programVersion("data"),
		functionsVersion: program.programVersion("functions"),
		flowRevision: program.programFlowRevision,
		generation: program.generation,
		entries: recordEntries(entries),
	});
	return selected;
}
