import type { CompilerGuardPlan, KnownBuiltinCall } from "../shared/compiler-facts.ts";
import type {
	CorePlanSpecialization,
	CorePlanSpecializationKind,
} from "./core-ir-regions.ts";
import type { CoreBlockId, CoreFunctionId, CoreInstructionId } from "./core-ir.ts";

declare const CORE_SPECIALIZATION_RECIPE_TABLE: unique symbol;

export interface CoreSpecializationRecipeTable {
	readonly count: number;
	readonly [CORE_SPECIALIZATION_RECIPE_TABLE]: true;
}

interface CoreSpecializationRecipeStorage {
	readonly kindIds: Uint8Array;
	readonly functions: Int32Array;
	readonly keyStringIds: Uint32Array;
	readonly representationStringIds: Uint32Array;
	readonly anchorOffsets: Uint32Array;
	readonly anchors: Int32Array;
	readonly claimOffsets: Uint32Array;
	readonly claims: Int32Array;
	readonly ordinaryBlockOffsets: Uint32Array;
	readonly ordinaryBlocks: Int32Array;
	readonly exceptionalBlockOffsets: Uint32Array;
	readonly exceptionalBlocks: Int32Array;
	readonly requirementOffsets: Uint32Array;
	readonly requirementValues: Int32Array;
	readonly requirementRepresentationStringIds: Uint32Array;
	readonly targetFunctionOffsets: Uint32Array;
	readonly targetFunctions: Int32Array;
	readonly admissionAnchors: Int32Array;
	readonly admissionModes: Uint8Array;
	readonly compositions: Uint8Array;
	readonly generatedCodeCosts: Int32Array;
	readonly compilerWorkCosts: Int32Array;
	readonly runtimeBenefits: Float64Array;
	readonly guardIds: Int32Array;
	readonly proofIds: Int32Array;
	readonly payloadOffsets: Uint32Array;
	readonly payload: Float64Array;
	readonly strings: ReadonlyArray<string>;
	readonly guards: ReadonlyArray<CompilerGuardPlan>;
	readonly proofs: ReadonlyArray<KnownBuiltinCall>;
}

const RECIPE_STORAGE = new WeakMap<
	CoreSpecializationRecipeTable,
	CoreSpecializationRecipeStorage
>();

function recipeStorage(
	table: CoreSpecializationRecipeTable,
): CoreSpecializationRecipeStorage {
	const storage = RECIPE_STORAGE.get(table);
	if (storage === undefined) throw new Error("Unknown Core specialization recipe table");
	return storage;
}

export interface CoreSpecializationRecipeStorageStatistics {
	readonly recipes: number;
	readonly numericBytes: number;
	readonly payloadCells: number;
	readonly strings: number;
	readonly guards: number;
	readonly proofs: number;
}

export function coreSpecializationRecipeStorageStatistics(
	table: CoreSpecializationRecipeTable,
): CoreSpecializationRecipeStorageStatistics {
	const storage = recipeStorage(table);
	const numericBytes = Object.values(storage)
		.filter((value): value is ArrayBufferView => ArrayBuffer.isView(value))
		.reduce((total, value) => total + value.byteLength, 0);
	return Object.freeze({
		recipes: table.count,
		numericBytes,
		payloadCells: storage.payload.length,
		strings: storage.strings.length,
		guards: storage.guards.length,
		proofs: storage.proofs.length,
	});
}

const RECIPE_KINDS = Object.freeze([
	"guarded-direct-call",
	"stack-object-plan",
	"dense-array-plan",
	"numeric-fusion",
	"string-split-projection",
	"regexp-exec-projection",
	"regexp-iterator-projection",
	"string-slice-number",
	"string-char-code-at-chain",
	"builtin-collection-call-chain",
	"array-values-iterator-cursor",
	"string-iterator-cursor",
	"typed-array-iterator-cursor",
	"map-iterator-cursor",
	"set-iterator-cursor",
	"iterator-result-virtualization",
	"iterator-entry-pair-virtualization",
	"fresh-array-length",
	"indexed-length-loop",
	"function-call-chain",
	"string-split-cursor",
] as const satisfies ReadonlyArray<CorePlanSpecializationKind>);

const RECIPE_KIND_IDS = new Map<CorePlanSpecializationKind, number>(
	RECIPE_KINDS.map((kind, id) => [kind, id]),
);

const COMMON_FIELDS = new Set([
	"id",
	"kind",
	"function",
	"anchors",
	"claimedInstructions",
	"ordinaryBlocks",
	"exceptionalBlocks",
	"representation",
	"requiredRepresentations",
	"target",
	"fallback",
	"semanticProtectors",
	"targetFunctions",
	"admission",
	"composition",
	"cost",
]);

const PayloadTag = Object.freeze({
	Undefined: 0,
	False: 1,
	True: 2,
	Number: 3,
	String: 4,
	Array: 5,
	Object: 6,
	Guard: 7,
	Proof: 8,
});

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isGuard(value: unknown): value is CompilerGuardPlan {
	return (
		isObject(value) &&
		Array.isArray(value.dependencies) &&
		Array.isArray(value.obligations)
	);
}

function isProof(value: unknown): value is KnownBuiltinCall {
	return (
		isObject(value) &&
		typeof value.operation === "string" &&
		isObject(value.identity) &&
		isObject(value.semantics)
	);
}

function range(offsets: Uint32Array, values: Int32Array, index: number): Array<number> {
	return Array.from(values.subarray(offsets[index], offsets[index + 1]));
}

export function buildCoreSpecializationRecipeTable(
	selections: ReadonlyArray<CorePlanSpecialization>,
): CoreSpecializationRecipeTable {
	const strings: Array<string> = [];
	const stringIds = new Map<string, number>();
	const internString = (value: string): number => {
		const existing = stringIds.get(value);
		if (existing !== undefined) return existing;
		const id = strings.length;
		strings.push(value);
		stringIds.set(value, id);
		return id;
	};
	const guards: Array<CompilerGuardPlan> = [];
	const guardIds = new WeakMap<CompilerGuardPlan, number>();
	const internGuard = (value: CompilerGuardPlan): number => {
		const existing = guardIds.get(value);
		if (existing !== undefined) return existing;
		const id = guards.length;
		guards.push(value);
		guardIds.set(value, id);
		return id;
	};
	const proofs: Array<KnownBuiltinCall> = [];
	const proofIds = new WeakMap<KnownBuiltinCall, number>();
	const internProof = (value: KnownBuiltinCall): number => {
		const existing = proofIds.get(value);
		if (existing !== undefined) return existing;
		const id = proofs.length;
		proofs.push(value);
		proofIds.set(value, id);
		return id;
	};
	const payload: Array<number> = [];
	const encode = (value: unknown): void => {
		if (value === undefined) {
			payload.push(PayloadTag.Undefined);
			return;
		}
		if (value === false) {
			payload.push(PayloadTag.False);
			return;
		}
		if (value === true) {
			payload.push(PayloadTag.True);
			return;
		}
		if (typeof value === "number") {
			payload.push(PayloadTag.Number, value);
			return;
		}
		if (typeof value === "string") {
			payload.push(PayloadTag.String, internString(value));
			return;
		}
		if (isGuard(value)) {
			payload.push(PayloadTag.Guard, internGuard(value));
			return;
		}
		if (isProof(value)) {
			payload.push(PayloadTag.Proof, internProof(value));
			return;
		}
		if (Array.isArray(value)) {
			payload.push(PayloadTag.Array, value.length);
			for (const entry of value) encode(entry);
			return;
		}
		if (isObject(value)) {
			const entries = Object.entries(value);
			payload.push(PayloadTag.Object, entries.length);
			for (const [key, entry] of entries) {
				payload.push(internString(key));
				encode(entry);
			}
			return;
		}
		throw new Error(`Unsupported Core specialization recipe payload: ${typeof value}`);
	};
	const collectRange = <Value>(
		offsets: Array<number>,
		values: Array<Value>,
		entries: ReadonlyArray<Value>,
	): void => {
		values.push(...entries);
		offsets.push(values.length);
	};
	const anchorOffsets = [0];
	const anchors: Array<number> = [];
	const claimOffsets = [0];
	const claims: Array<number> = [];
	const ordinaryBlockOffsets = [0];
	const ordinaryBlocks: Array<number> = [];
	const exceptionalBlockOffsets = [0];
	const exceptionalBlocks: Array<number> = [];
	const requirementOffsets = [0];
	const requirementValues: Array<number> = [];
	const requirementRepresentations: Array<number> = [];
	const targetFunctionOffsets = [0];
	const targetFunctions: Array<number> = [];
	const payloadOffsets = [0];
	const kindIds: Array<number> = [];
	const functions: Array<number> = [];
	const keyStringIds: Array<number> = [];
	const representationStringIds: Array<number> = [];
	const admissionAnchors: Array<number> = [];
	const admissionModes: Array<number> = [];
	const compositions: Array<number> = [];
	const generatedCodeCosts: Array<number> = [];
	const compilerWorkCosts: Array<number> = [];
	const runtimeBenefits: Array<number> = [];
	const primaryGuardIds: Array<number> = [];
	const primaryProofIds: Array<number> = [];
	for (const selection of selections) {
		kindIds.push(RECIPE_KIND_IDS.get(selection.kind)!);
		functions.push(selection.function);
		keyStringIds.push(internString(selection.id));
		representationStringIds.push(internString(selection.representation));
		collectRange(anchorOffsets, anchors, selection.anchors);
		collectRange(claimOffsets, claims, selection.claimedInstructions);
		collectRange(ordinaryBlockOffsets, ordinaryBlocks, selection.ordinaryBlocks);
		collectRange(exceptionalBlockOffsets, exceptionalBlocks, selection.exceptionalBlocks);
		for (const requirement of selection.requiredRepresentations) {
			requirementValues.push(requirement.value);
			requirementRepresentations.push(internString(requirement.representation));
		}
		requirementOffsets.push(requirementValues.length);
		collectRange(targetFunctionOffsets, targetFunctions, selection.targetFunctions);
		const admission = selection.admission as typeof selection.admission | undefined;
		admissionAnchors.push(admission?.anchor ?? -1);
		admissionModes.push(
			admission === undefined
				? 255
				: admission.mode === "capture"
					? 0
					: admission.mode === "stable"
						? 1
						: 2,
		);
		compositions.push(selection.composition === "exclusive" ? 0 : 1);
		generatedCodeCosts.push(selection.cost.generatedCode);
		compilerWorkCosts.push(selection.cost.compilerWork);
		runtimeBenefits.push(selection.cost.runtimeBenefit);
		const recipePayload: Record<string, unknown> = {};
		let primaryGuard = -1;
		let primaryProof = -1;
		for (const [key, value] of Object.entries(selection)) {
			if (COMMON_FIELDS.has(key)) continue;
			recipePayload[key] = value;
			if (isObject(value)) {
				const guard = value.guard;
				if (primaryGuard < 0 && isGuard(guard)) primaryGuard = internGuard(guard);
				for (const nested of Object.values(value)) {
					if (primaryProof < 0 && isProof(nested)) primaryProof = internProof(nested);
				}
			}
		}
		primaryGuardIds.push(primaryGuard);
		primaryProofIds.push(primaryProof);
		encode(recipePayload);
		payloadOffsets.push(payload.length);
	}
	const storage: CoreSpecializationRecipeStorage = {
		kindIds: Uint8Array.from(kindIds),
		functions: Int32Array.from(functions),
		keyStringIds: Uint32Array.from(keyStringIds),
		representationStringIds: Uint32Array.from(representationStringIds),
		anchorOffsets: Uint32Array.from(anchorOffsets),
		anchors: Int32Array.from(anchors),
		claimOffsets: Uint32Array.from(claimOffsets),
		claims: Int32Array.from(claims),
		ordinaryBlockOffsets: Uint32Array.from(ordinaryBlockOffsets),
		ordinaryBlocks: Int32Array.from(ordinaryBlocks),
		exceptionalBlockOffsets: Uint32Array.from(exceptionalBlockOffsets),
		exceptionalBlocks: Int32Array.from(exceptionalBlocks),
		requirementOffsets: Uint32Array.from(requirementOffsets),
		requirementValues: Int32Array.from(requirementValues),
		requirementRepresentationStringIds: Uint32Array.from(requirementRepresentations),
		targetFunctionOffsets: Uint32Array.from(targetFunctionOffsets),
		targetFunctions: Int32Array.from(targetFunctions),
		admissionAnchors: Int32Array.from(admissionAnchors),
		admissionModes: Uint8Array.from(admissionModes),
		compositions: Uint8Array.from(compositions),
		generatedCodeCosts: Int32Array.from(generatedCodeCosts),
		compilerWorkCosts: Int32Array.from(compilerWorkCosts),
		runtimeBenefits: Float64Array.from(runtimeBenefits),
		guardIds: Int32Array.from(primaryGuardIds),
		proofIds: Int32Array.from(primaryProofIds),
		payloadOffsets: Uint32Array.from(payloadOffsets),
		payload: Float64Array.from(payload),
		strings: Object.freeze(strings),
		guards: Object.freeze(guards),
		proofs: Object.freeze(proofs),
	};
	const table = Object.freeze({
		count: selections.length,
	}) as CoreSpecializationRecipeTable;
	RECIPE_STORAGE.set(table, storage);
	return table;
}

function decodeRecipePayload(
	table: CoreSpecializationRecipeTable,
	index: number,
): Record<string, unknown> {
	if (index < 0 || index >= table.count) {
		throw new Error(`Core specialization recipe ${index} is out of range`);
	}
	const storage = recipeStorage(table);
	let cursor = storage.payloadOffsets[index]!;
	const limit = storage.payloadOffsets[index + 1]!;
	const decode = (): unknown => {
		if (cursor >= limit)
			throw new Error(`Core specialization recipe ${index} is truncated`);
		const tag = storage.payload[cursor++]!;
		switch (tag) {
			case PayloadTag.Undefined:
				return undefined;
			case PayloadTag.False:
				return false;
			case PayloadTag.True:
				return true;
			case PayloadTag.Number:
				return storage.payload[cursor++]!;
			case PayloadTag.String:
				return storage.strings[storage.payload[cursor++]!]!;
			case PayloadTag.Guard:
				return storage.guards[storage.payload[cursor++]!]!;
			case PayloadTag.Proof:
				return storage.proofs[storage.payload[cursor++]!]!;
			case PayloadTag.Array: {
				const length = storage.payload[cursor++]!;
				return Array.from({ length }, () => decode());
			}
			case PayloadTag.Object: {
				const length = storage.payload[cursor++]!;
				const object: Record<string, unknown> = {};
				for (let entry = 0; entry < length; entry++) {
					const key = storage.strings[storage.payload[cursor++]!]!;
					object[key] = decode();
				}
				return object;
			}
			default:
				throw new Error(`Core specialization recipe ${index} has tag ${tag}`);
		}
	};
	const payload = decode() as Record<string, unknown>;
	if (cursor !== limit)
		throw new Error(`Core specialization recipe ${index} has trailing data`);
	return payload;
}

type CoreSpecializationRecipeCommonKey =
	| "id"
	| "kind"
	| "function"
	| "anchors"
	| "claimedInstructions"
	| "ordinaryBlocks"
	| "exceptionalBlocks"
	| "representation"
	| "requiredRepresentations"
	| "target"
	| "fallback"
	| "semanticProtectors"
	| "targetFunctions"
	| "admission"
	| "composition"
	| "cost";

type CoreSpecializationRecipeFor<Kind extends CorePlanSpecializationKind> = Extract<
	CorePlanSpecialization,
	{ readonly kind: Kind }
>;

export function coreSpecializationRecipeKindAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): CorePlanSpecializationKind {
	if (index < 0 || index >= table.count)
		throw new Error(`Core specialization recipe ${index} is out of range`);
	const storage = recipeStorage(table);
	return RECIPE_KINDS[storage.kindIds[index]!]!;
}

export function coreSpecializationRecipeFunctionAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): CoreFunctionId {
	if (index < 0 || index >= table.count)
		throw new Error(`Core specialization recipe ${index} is out of range`);
	return recipeStorage(table).functions[index]! as CoreFunctionId;
}

export function coreSpecializationRecipeRepresentationAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): string {
	if (index < 0 || index >= table.count)
		throw new Error(`Core specialization recipe ${index} is out of range`);
	const storage = recipeStorage(table);
	return storage.strings[storage.representationStringIds[index]!]!;
}

export function coreSpecializationRecipeIdAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): string {
	if (index < 0 || index >= table.count)
		throw new Error(`Core specialization recipe ${index} is out of range`);
	const storage = recipeStorage(table);
	return storage.strings[storage.keyStringIds[index]!]!;
}

export function coreSpecializationRecipeAnchorsAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): ReadonlyArray<CoreInstructionId> {
	const storage = recipeStorage(table);
	return range(storage.anchorOffsets, storage.anchors, index) as Array<CoreInstructionId>;
}

export function coreSpecializationRecipeClaimsAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): ReadonlyArray<CoreInstructionId> {
	const storage = recipeStorage(table);
	return range(storage.claimOffsets, storage.claims, index) as Array<CoreInstructionId>;
}

export function coreSpecializationRecipeOrdinaryBlocksAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): ReadonlyArray<CoreBlockId> {
	const storage = recipeStorage(table);
	return range(
		storage.ordinaryBlockOffsets,
		storage.ordinaryBlocks,
		index,
	) as Array<CoreBlockId>;
}

export function coreSpecializationRecipeExceptionalBlocksAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): ReadonlyArray<CoreBlockId> {
	const storage = recipeStorage(table);
	return range(
		storage.exceptionalBlockOffsets,
		storage.exceptionalBlocks,
		index,
	) as Array<CoreBlockId>;
}

export function coreSpecializationRecipeTargetFunctionsAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): ReadonlyArray<CoreFunctionId> {
	const storage = recipeStorage(table);
	return range(
		storage.targetFunctionOffsets,
		storage.targetFunctions,
		index,
	) as Array<CoreFunctionId>;
}

export function coreSpecializationRecipeAdmissionAt(
	table: CoreSpecializationRecipeTable,
	index: number,
): CorePlanSpecialization["admission"] {
	const storage = recipeStorage(table);
	const mode = storage.admissionModes[index];
	if (mode === 255) return undefined as unknown as CorePlanSpecialization["admission"];
	return {
		anchor: storage.admissionAnchors[index]! as CoreInstructionId,
		mode: mode === 0 ? "capture" : mode === 1 ? "stable" : "per-use",
	};
}

export function coreSpecializationRecipePayloadAt<
	Kind extends CorePlanSpecializationKind,
	Key extends Exclude<
		keyof CoreSpecializationRecipeFor<Kind>,
		CoreSpecializationRecipeCommonKey
	>,
>(
	table: CoreSpecializationRecipeTable,
	index: number,
	kind: Kind,
	key: Key,
): CoreSpecializationRecipeFor<Kind>[Key] {
	const actualKind = coreSpecializationRecipeKindAt(table, index);
	if (actualKind !== kind) {
		throw new Error(
			`Core specialization recipe ${index} is ${actualKind}, expected ${kind}`,
		);
	}
	const payload = decodeRecipePayload(table, index);
	if (!(key in payload)) {
		throw new Error(`Core specialization recipe ${index} has no ${String(key)} payload`);
	}
	return payload[key as string];
}

export function projectCoreSpecializationRecipe(
	table: CoreSpecializationRecipeTable,
	index: number,
): CorePlanSpecialization {
	const storage = recipeStorage(table);
	const payload = decodeRecipePayload(table, index);
	const requirementStart = storage.requirementOffsets[index]!;
	const requirementEnd = storage.requirementOffsets[index + 1]!;
	return {
		id: storage.strings[storage.keyStringIds[index]!]!,
		kind: RECIPE_KINDS[storage.kindIds[index]!]!,
		function: storage.functions[index]!,
		anchors: range(storage.anchorOffsets, storage.anchors, index),
		claimedInstructions: range(storage.claimOffsets, storage.claims, index),
		ordinaryBlocks: range(storage.ordinaryBlockOffsets, storage.ordinaryBlocks, index),
		exceptionalBlocks: range(
			storage.exceptionalBlockOffsets,
			storage.exceptionalBlocks,
			index,
		),
		representation: storage.strings[storage.representationStringIds[index]!]!,
		requiredRepresentations: Array.from(
			{ length: requirementEnd - requirementStart },
			(_, offset) => ({
				value: storage.requirementValues[requirementStart + offset]!,
				representation:
					storage.strings[
						storage.requirementRepresentationStringIds[requirementStart + offset]!
					]!,
			}),
		),
		target: "native",
		fallback: "canonical-core",
		semanticProtectors: [],
		targetFunctions: range(storage.targetFunctionOffsets, storage.targetFunctions, index),
		admission:
			storage.admissionModes[index] === 255
				? undefined
				: {
						anchor: storage.admissionAnchors[index]!,
						mode:
							storage.admissionModes[index] === 0
								? "capture"
								: storage.admissionModes[index] === 1
									? "stable"
									: "per-use",
					},
		composition: storage.compositions[index] === 0 ? "exclusive" : "overlay",
		cost: {
			generatedCode: storage.generatedCodeCosts[index]!,
			compilerWork: storage.compilerWorkCosts[index]!,
			runtimeBenefit: storage.runtimeBenefits[index]!,
		},
		...payload,
	} as unknown as CorePlanSpecialization;
}

export function projectCoreSpecializationRecipes(
	table: CoreSpecializationRecipeTable,
): ReadonlyArray<CorePlanSpecialization> {
	return Array.from({ length: table.count }, (_, index) =>
		projectCoreSpecializationRecipe(table, index),
	);
}
