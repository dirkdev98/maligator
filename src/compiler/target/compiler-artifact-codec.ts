import { coreRegionStrategy } from "../core/core-ir-region-strategies.ts";
import type { CorePropertyPlacement } from "../core/core-ir-regions.ts";
import type {
	CompilerExactCollectionBrand,
	CompilerNumericTypedArrayKind,
} from "../shared/compiler-instruction.ts";
import {
	compilerOperatorInputKindsHaveExactNativeSemantics,
	compilerBuiltinInputKindsAreValid,
} from "../shared/compiler-value-kinds.ts";
import type { CompilerOperatorInputKindMasks } from "../shared/compiler-value-kinds.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import type { Reader } from "./program-image-codec.ts";
import { readRuntimeImage, Writer, writeRuntimeImage } from "./program-image-codec.ts";
import {
	nativeFrameRootRegisters,
	validateNativeDirectEntry,
	validateNativeFieldCalls,
	validateNativeLiteralSwitches,
	validateNativeNumericSortCallback,
	vmRegionActions,
	vmRegionActionsAreCurrent,
	vmGuardIsWorldInvariant,
	VM_GUARDED_BUILTIN_OPERATIONS,
} from "./program-image.ts";
import type {
	NativeFunctionPlan,
	NativeInstructionPlan,
	ProgramImage,
	VmGuardedBuiltinCall,
	VmRegisterRepresentation,
	VmRegion,
	VmSemanticProtectorFact,
} from "./program-image.ts";
import { decodeVmValueOperand, validateVmShapeCases } from "./runtime-image.ts";
import type {
	BytecodeFunction,
	BytecodeInstruction,
	RuntimeImage,
} from "./runtime-image.ts";

/** Host-compiler cache format. This metadata never reaches the VM loader. */
export const COMPILER_ARTIFACT_MAGIC = 0x434c414d; // "MALC" little-endian
// Internal artifacts are hard cut-overs: stale cache entries rebuild.
export const COMPILER_ARTIFACT_VERSION = 83;

const MAX_REGION_ANCHORS = 8;
const MAX_REGION_CLAIMS = 96;
const MAX_REGION_ORDINARY_BLOCKS = 64;
const MAX_STRING_SPLIT_CURSOR_LENGTH_LOADS = 64;
const TAGGED_GUARDED_BUILTIN_OPERATIONS = [
	"Map.prototype.get",
	"Map.prototype.set",
	"Set.prototype.add",
	"Map.prototype.has",
	"Map.prototype.delete",
	"Set.prototype.has",
	"Set.prototype.delete",
	"String.prototype.split",
	"String.prototype.trim",
	"String.prototype.slice",
	...VM_GUARDED_BUILTIN_OPERATIONS.filter((operation) => operation.startsWith("Math.")),
	"RegExp.prototype.exec",
	...VM_GUARDED_BUILTIN_OPERATIONS.filter(
		(operation) =>
			operation.startsWith("Array.prototype.") && operation !== "Array.prototype.push",
	),
	...VM_GUARDED_BUILTIN_OPERATIONS.filter((operation) => operation.startsWith("Number.")),
	...VM_GUARDED_BUILTIN_OPERATIONS.filter(
		(operation) => operation === "Boolean" || operation.startsWith("Boolean."),
	),
] as const;
const ARRAY_ITERATION_CALLBACK_OPERATIONS: ReadonlySet<string> = new Set([
	"Array.prototype.forEach",
	"Array.prototype.some",
	"Array.prototype.every",
	"Array.prototype.find",
	"Array.prototype.findIndex",
	"Array.prototype.map",
	"Array.prototype.filter",
	"Array.prototype.reduce",
	"Array.prototype.reduceRight",
	"Array.prototype.findLast",
	"Array.prototype.findLastIndex",
	"Array.prototype.flatMap",
]);

function sameOptionalFunctionTargets(
	left: ReadonlyArray<number> | undefined,
	right: ReadonlyArray<number> | undefined,
): boolean {
	const leftTargets = left ?? [];
	const rightTargets = right ?? [];
	return (
		leftTargets.length === rightTargets.length &&
		leftTargets.every((target, index) => target === rightTargets[index])
	);
}

const TAGGED_NUMERIC_TYPED_ARRAY_KINDS = [
	"Int8Array",
	"Uint8Array",
	"Uint8ClampedArray",
	"Int16Array",
	"Uint16Array",
	"Int32Array",
	"Uint32Array",
	"Float32Array",
	"Float64Array",
] as const satisfies ReadonlyArray<CompilerNumericTypedArrayKind>;

function taggedNumericTypedArrayKind(kind: CompilerNumericTypedArrayKind): number {
	const tag = (TAGGED_NUMERIC_TYPED_ARRAY_KINDS as ReadonlyArray<string>).indexOf(kind);
	if (tag < 0) throw new RangeError("program-image-codec: invalid TypedArray kind");
	return tag;
}

function numericTypedArrayKindFromTag(tag: number): CompilerNumericTypedArrayKind {
	const kind = TAGGED_NUMERIC_TYPED_ARRAY_KINDS[tag];
	if (kind === undefined) {
		throw new RangeError("program-image-codec: invalid TypedArray kind tag");
	}
	return kind;
}

function taggedGuardedBuiltinOperation(operation: string | undefined): number {
	if (
		operation === undefined ||
		operation === "Array.prototype.push" ||
		operation === "String.prototype.charCodeAt"
	) {
		return 0;
	}
	const index = (TAGGED_GUARDED_BUILTIN_OPERATIONS as ReadonlyArray<string>).indexOf(
		operation,
	);
	if (index < 0)
		throw new RangeError(`program-image-codec: unsupported builtin ${operation}`);
	return index + 1;
}

function guardedBuiltinCallBrandTag(
	tag: number,
): CompilerExactCollectionBrand | undefined {
	const operation = TAGGED_GUARDED_BUILTIN_OPERATIONS[tag - 1];
	if (operation?.startsWith("Map.prototype.")) return "Map";
	if (operation?.startsWith("Set.prototype.")) return "Set";
	return undefined;
}

function collectionOperationFromTag(
	tag: number,
): Extract<VmRegion, { kind: "builtin-collection-call-chain" }>["operation"] {
	const operation = TAGGED_GUARDED_BUILTIN_OPERATIONS[tag - 1];
	if (
		operation !== "Map.prototype.get" &&
		operation !== "Map.prototype.set" &&
		operation !== "Map.prototype.has" &&
		operation !== "Map.prototype.delete" &&
		operation !== "Set.prototype.add" &&
		operation !== "Set.prototype.has" &&
		operation !== "Set.prototype.delete"
	) {
		throw new RangeError("program-image-codec: invalid collection operation tag");
	}
	return operation;
}

function stringSplitCursorGuardMasks(
	license: Extract<VmRegion, { kind: "string-split-cursor" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"program-image-codec: unsupported String.split cursor dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "on-demand" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError("program-image-codec: invalid String.split cursor guard plan");
	}
	return { dependencyMask, obligationMask };
}

function stringSplitProjectionGuardMasks(
	license: Extract<VmRegion, { kind: "string-split-projection" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"program-image-codec: unsupported String.split projection dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "whole-region" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError(
			"program-image-codec: invalid String.split projection guard plan",
		);
	}
	return { dependencyMask, obligationMask };
}

function regexpExecProjectionGuardMasks(
	license: Extract<VmRegion, { kind: "regexp-exec-projection" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"program-image-codec: unsupported RegExp.exec projection dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "whole-region" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError(
			"program-image-codec: invalid RegExp.exec projection guard plan",
		);
	}
	return { dependencyMask, obligationMask };
}

function regexpIteratorProjectionGuardMasks(
	license: Extract<VmRegion, { kind: "regexp-iterator-projection" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"program-image-codec: unsupported RegExp iterator projection dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "on-demand" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError(
			"program-image-codec: invalid RegExp iterator projection guard plan",
		);
	}
	return { dependencyMask, obligationMask };
}

/**
 * Re-check a decoded `call-fallback` placement. Core owns the proof that the load
 * is dead on the fast path; the wire boundary re-proves only what a corrupt or
 * stale image could break — that the deferred load produces the call's callee and
 * shares its handler coverage, so its throw is still caught in the same place.
 */
function propertyPlacementHolds(
	fn: BytecodeFunction,
	placement: CorePropertyPlacement,
	propertyIp: number,
	callIp: number,
): boolean {
	if (placement === "in-place") return true;
	if (placement !== "call-fallback") return false;
	const property = fn.instructions[propertyIp];
	const call = fn.instructions[callIp];
	if (property?.opcode !== "LOAD_PROPERTY_STATIC" || call?.opcode !== "CALL")
		return false;
	if (call.callee !== property.dst) return false;
	const covering = (ip: number): string =>
		fn.handlers
			.filter((handler) => ip >= handler.startIp && ip < handler.endIp)
			.map((handler) => handler.handlerIp)
			.sort((left, right) => left - right)
			.join(",");
	return covering(propertyIp) === covering(callIp);
}

/** Core's property-producer placement travels as a closed two-value tag. */
function readPropertyPlacement(r: Reader): CorePropertyPlacement {
	const tag = r.u8();
	if (tag > 1)
		throw new RangeError("program-image-codec: invalid region property placement");
	return tag === 1 ? "call-fallback" : "in-place";
}

function writePropertyPlacement(w: Writer, placement: CorePropertyPlacement): void {
	if (placement !== "in-place" && placement !== "call-fallback") {
		throw new RangeError("program-image-codec: invalid region property placement");
	}
	w.u8(placement === "call-fallback" ? 1 : 0);
}

function stringSliceNumberGuardMasks(
	license: Extract<VmRegion, { kind: "string-slice-number" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"program-image-codec: unsupported String.slice Number dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "none" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 1
	) {
		throw new RangeError("program-image-codec: invalid String.slice Number guard plan");
	}
	return { dependencyMask, obligationMask };
}

function stringCharCodeAtChainGuardMasks(
	license: Extract<VmRegion, { kind: "string-char-code-at-chain" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"program-image-codec: unsupported String.charCodeAt chain dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "none" ||
		license.admission.mode !== "capture" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 1
	) {
		throw new RangeError(
			"program-image-codec: invalid String.charCodeAt chain guard plan",
		);
	}
	return { dependencyMask, obligationMask };
}

function builtinCollectionCallChainGuardMasks(
	license: Extract<VmRegion, { kind: "builtin-collection-call-chain" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"program-image-codec: unsupported builtin collection chain dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "none" ||
		license.admission.mode !== "capture" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 1
	) {
		throw new RangeError("program-image-codec: invalid builtin collection chain guard");
	}
	return { dependencyMask, obligationMask };
}

function iteratorEntryPairGuardMasks(
	license: Extract<VmRegion, { kind: "iterator-entry-pair-virtualization" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "watched-methods") {
			dependencyMask |= 4;
		} else {
			throw new RangeError(
				"program-image-codec: unsupported iterator entry-pair dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		license.materialization !== "on-demand" ||
		license.admission.mode !== "capture" ||
		(dependencyMask !== 1 && dependencyMask !== 4) ||
		obligationMask !== 3
	) {
		throw new RangeError("program-image-codec: invalid iterator entry-pair guard");
	}
	return { dependencyMask, obligationMask };
}

function stackObjectPlanGuardMasks(
	license: Extract<VmRegion, { kind: "stack-object-plan" }>["license"],
): { dependencyMask: number; obligationMask: number } {
	let dependencyMask = 0;
	for (const dependency of license.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === "primitive-methods") {
			dependencyMask |= 2;
		} else {
			throw new RangeError("program-image-codec: unsupported stack-object dependency");
		}
	}
	let obligationMask = 0;
	for (const obligation of license.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	if (
		license.genericTwin !== "retained" ||
		(license.materialization !== "none" && license.materialization !== "on-demand") ||
		![0, 1, 2].includes(dependencyMask) ||
		obligationMask !== (license.materialization === "none" ? 1 : 3)
	) {
		throw new RangeError("program-image-codec: invalid stack-object guard plan");
	}
	return { dependencyMask, obligationMask };
}

const SEMANTIC_PROTECTOR_TAGS = {
	"primitive-methods": 1,
	"watched-methods": 2,
	"array-elements": 3,
} as const;

function semanticProtectorGuardMasks(fact: VmSemanticProtectorFact): {
	dependencyMask: number;
	obligationMask: number;
} {
	let dependencyMask = 0;
	for (const dependency of fact.guard.dependencies) {
		if (dependency.kind === "world" && dependency.fact === "primordials.locked") {
			dependencyMask |= 1;
		} else if (dependency.kind === "epoch" && dependency.family === fact.family) {
			dependencyMask |= 1 << SEMANTIC_PROTECTOR_TAGS[fact.family];
		} else {
			throw new RangeError(
				"program-image-codec: mismatched semantic protector dependency",
			);
		}
	}
	let obligationMask = 0;
	for (const obligation of fact.guard.obligations) {
		obligationMask |= obligation === "fallback" ? 1 : 2;
	}
	const epochMask = 1 << SEMANTIC_PROTECTOR_TAGS[fact.family];
	if ((dependencyMask !== 1 && dependencyMask !== epochMask) || obligationMask !== 1) {
		throw new RangeError("program-image-codec: invalid semantic protector fact");
	}
	return { dependencyMask, obligationMask };
}

export function serializeCompilerArtifact(
	image: ProgramImage,
	options: { debugInfo?: boolean } = {},
): Uint8Array {
	const writer = new Writer();
	writeRuntimeImage(
		writer,
		image.runtime,
		COMPILER_ARTIFACT_MAGIC,
		COMPILER_ARTIFACT_VERSION,
		options,
	);
	writeCompilerArtifact(writer, image.runtime, image);
	return writer.finish();
}

function writeCompilerArtifact(
	w: Writer,
	def: RuntimeImage,
	compiler: ProgramImage,
): void {
	const semanticProtectors = [...compiler.native.semanticProtectors];
	if (
		semanticProtectors.length > 3 ||
		new Set(semanticProtectors.map((fact) => fact.family)).size !==
			semanticProtectors.length
	) {
		throw new RangeError("program-image-codec: duplicate semantic protector facts");
	}
	w.u32(semanticProtectors.length);
	for (const fact of semanticProtectors) {
		const { dependencyMask, obligationMask } = semanticProtectorGuardMasks(fact);
		w.u8(SEMANTIC_PROTECTOR_TAGS[fact.family]);
		w.u8(dependencyMask);
		w.u8(obligationMask);
	}

	// The compiler artifact appends native-only plans to the runtime payload. Its
	// distinct magic prevents this richer artifact from ever reaching the VM loader.
	w.u32(compiler.native.functions.length);
	for (const [functionIndex, fn] of def.functions.entries()) {
		const native = compiler.native.functions[functionIndex];
		if (native?.functionIndex !== functionIndex) {
			throw new RangeError("program-image-codec: native function plan mismatch");
		}
		validateNativeFieldCalls(fn, native, compiler.native.functions);
		validateNativeLiteralSwitches(fn, native);
		const representationTag = (representation: string): number =>
			representation === "boxed"
				? 0
				: representation === "int32"
					? 3
					: representation === "number"
						? 1
						: representation === "boolean"
							? 2
							: representation === "string"
								? 4
								: -1;
		if (
			native.registerRepresentations.length !== fn.registerCount ||
			native.registerRepresentations.some(
				(representation, register) =>
					representationTag(representation) < 0 ||
					(register < fn.parameterCount && representation !== "boxed"),
			)
		) {
			throw new RangeError("program-image-codec: invalid register representations");
		}
		nativeFrameRootRegisters(fn, native);
		w.u32(native.gc.safepoints.length);
		for (const safepoint of native.gc.safepoints) {
			w.u8(
				safepoint.kind === "operation" ? 0 : safepoint.kind === "loop-backedge" ? 1 : 2,
			);
			w.i32(safepoint.instructionIp);
			w.i32Array([...safepoint.rootRegisters]);
		}

		w.u32(native.registerRepresentations.length);
		for (const representation of native.registerRepresentations) {
			w.u8(representationTag(representation));
		}

		if (native.directEntries.length > 4) {
			throw new RangeError("program-image-codec: too many native direct entries");
		}
		w.u32(native.literalSwitches?.length ?? 0);
		for (const site of native.literalSwitches ?? []) {
			w.u8(site.kind === "number" ? 0 : 1);
			w.u32(site.instructionIp);
			w.u32(site.endIp);
			w.u32(site.selector);
			w.u32(site.defaultIp);
			w.u32(site.cases.length);
			if (site.kind === "number")
				for (const label of site.cases) {
					w.i32(label.value);
					w.u32(label.targetIp);
				}
			else
				for (const label of site.cases) {
					w.u32(label.stringIndex);
					w.u32(label.targetIp);
				}
		}
		w.u32(native.fieldCalls?.length ?? 0);
		for (const site of native.fieldCalls ?? []) {
			w.u32(site.allocationIp);
			w.u32(site.callIp);
			w.u32(site.entries.length);
			for (const entry of site.entries) {
				w.u32(entry.functionIndex);
				w.u32(entry.entryId);
			}
		}
		w.u8(native.specializedOnly ? 1 : 0);
		w.u32(native.directEntries.length);
		for (const [entryIndex, entry] of native.directEntries.entries()) {
			if (
				entry.id !== entryIndex ||
				entry.parameterRepresentations.length !== fn.parameterCount ||
				entry.registerRepresentations.length !== fn.registerCount ||
				entry.parameterRepresentations.some(
					(representation, register) =>
						representationTag(representation) < 0 ||
						entry.registerRepresentations[register] !== representation,
				) ||
				entry.registerRepresentations.some(
					(representation) => representationTag(representation) < 0,
				) ||
				representationTag(entry.resultRepresentation) < 0
			) {
				throw new RangeError("program-image-codec: invalid native direct entry");
			}
			validateNativeDirectEntry(fn, entry);
			nativeFrameRootRegisters(fn, entry);
			w.u32(entry.id);
			w.u8(representationTag(entry.resultRepresentation));
			w.u32(entry.parameterRepresentations.length);
			for (const representation of entry.parameterRepresentations) {
				w.u8(representationTag(representation));
			}
			w.i32(entry.argumentRepresentations?.length ?? -1);
			for (const representation of entry.argumentRepresentations ?? [])
				w.u8(representationTag(representation));
			w.u32(entry.fieldParameters?.keys.length ?? 0);
			for (const key of entry.fieldParameters?.keys ?? []) w.u32(key);
			w.u32(entry.fieldParameters?.loads.length ?? 0);
			for (const load of entry.fieldParameters?.loads ?? []) {
				w.u32(load.instructionIp);
				w.u32(load.field);
			}
			w.u32(entry.constantBooleans?.length ?? 0);
			for (const { instructionIp, value } of entry.constantBooleans ?? []) {
				if (
					fn.instructions[instructionIp]?.opcode !== "BINARY" ||
					typeof value !== "boolean"
				)
					throw new Error("program-image-codec: invalid direct-entry comparison");
				w.i32(instructionIp);
				w.u8(value ? 1 : 0);
			}
			w.u32(entry.operatorInputs?.length ?? 0);
			for (const { instructionIp, masks } of entry.operatorInputs ?? []) {
				w.u32(instructionIp);
				w.u8(masks.length);
				for (const mask of masks) w.u8(mask);
			}
			w.u32(entry.registerRepresentations.length);
			for (const representation of entry.registerRepresentations) {
				w.u8(representationTag(representation));
			}
			w.u32(entry.gc.safepoints.length);
			for (const safepoint of entry.gc.safepoints) {
				if (safepoint.kind === "conservative") {
					throw new RangeError(
						"program-image-codec: direct-entry safepoints must carry exact roots",
					);
				}
				w.u8(safepoint.kind === "operation" ? 0 : 1);
				w.i32(safepoint.instructionIp);
				w.i32Array([...safepoint.rootRegisters]);
			}
		}

		if (native.instructions.length !== fn.instructions.length) {
			throw new RangeError("program-image-codec: native instruction-plan count mismatch");
		}
		const instructionMetadata = native.instructions.flatMap((plan, instructionIndex) =>
			plan === undefined ? [] : [{ plan, instructionIndex }],
		);
		w.u32(instructionMetadata.length);
		for (const { plan, instructionIndex } of instructionMetadata) {
			const instruction = fn.instructions[instructionIndex]!;
			w.u32(instructionIndex);
			if (plan.kind === "call" && instruction.opcode === "CALL") {
				const guardedFunctionIndices = plan.guardedFunctionIndices;
				const guardedBuiltin = plan.guardedBuiltinCall;
				const guardedOperation = guardedBuiltin?.operation;
				const guardedDependency = guardedBuiltin?.guard.dependencies[0];
				const exactCollectionOperation =
					plan.exactCollectionReceiver === "Map"
						? guardedOperation === "Map.prototype.get" ||
							guardedOperation === "Map.prototype.set" ||
							guardedOperation === "Map.prototype.has" ||
							guardedOperation === "Map.prototype.delete"
						: plan.exactCollectionReceiver === "Set"
							? guardedOperation === "Set.prototype.add" ||
								guardedOperation === "Set.prototype.has" ||
								guardedOperation === "Set.prototype.delete"
							: true;
				if (
					!exactCollectionOperation ||
					plan.directFunctionIndex !== instruction.exactFunctionIndex ||
					!sameOptionalFunctionTargets(
						guardedFunctionIndices,
						instruction.guardedFunctionIndices,
					) ||
					(plan.directFunctionIndex !== undefined &&
						(!Number.isInteger(plan.directFunctionIndex) ||
							plan.directFunctionIndex < 0 ||
							plan.directFunctionIndex >= def.functions.length)) ||
					(guardedFunctionIndices !== undefined &&
						(plan.directFunctionIndex !== undefined ||
							guardedFunctionIndices.length < 1 ||
							guardedFunctionIndices.length > 4 ||
							guardedFunctionIndices.some(
								(target, index) =>
									!Number.isSafeInteger(target) ||
									target < 0 ||
									target >= def.functions.length ||
									(index > 0 && target <= guardedFunctionIndices[index - 1]!),
							))) ||
					(plan.directEntryId !== undefined &&
						((plan.directFunctionIndex === undefined &&
							guardedFunctionIndices?.length !== 1) ||
							!Number.isInteger(plan.directEntryId) ||
							plan.directEntryId < 0 ||
							compiler.native.functions[
								plan.directFunctionIndex ?? guardedFunctionIndices![0]!
							]?.directEntries[plan.directEntryId]?.id !== plan.directEntryId)) ||
					(plan.directCallTargetFunctionIndex !== undefined &&
						(!Number.isInteger(plan.directCallTargetFunctionIndex) ||
							plan.directCallTargetFunctionIndex < 0 ||
							plan.directCallTargetFunctionIndex >= def.functions.length ||
							plan.directFunctionCall !== true)) ||
					(plan.directCallbackFunctionIndex !== undefined &&
						(!Number.isInteger(plan.directCallbackFunctionIndex) ||
							plan.directCallbackFunctionIndex < 0 ||
							plan.directCallbackFunctionIndex >= def.functions.length ||
							guardedOperation === undefined ||
							!ARRAY_ITERATION_CALLBACK_OPERATIONS.has(guardedOperation))) ||
					(guardedBuiltin !== undefined &&
						(guardedBuiltin.guard.dependencies.length !== 1 ||
							guardedBuiltin.guard.obligations.length !== 1 ||
							guardedBuiltin.guard.obligations[0] !== "fallback" ||
							guardedDependency === undefined ||
							(guardedDependency.kind === "world"
								? guardedDependency.fact !== "primordials.locked"
								: guardedDependency.family !== "watched-methods")))
				) {
					throw new RangeError(
						"program-image-codec: invalid CALL specialization metadata",
					);
				}
				if (
					plan.directStringCharCodeAtPosition !== undefined &&
					guardedOperation !== "String.prototype.charCodeAt"
				) {
					throw new RangeError(
						"program-image-codec: mismatched guarded builtin metadata",
					);
				}
				w.u8(1);
				w.i32(plan.directFunctionIndex ?? -1);
				w.i32Array([...(guardedFunctionIndices ?? [])]);
				w.i32(plan.directCallTargetFunctionIndex ?? -1);
				w.i32(plan.directCallbackFunctionIndex ?? -1);
				w.i32(plan.directEntryId ?? -1);
				const numericCallback = plan.numericSortCallback;
				if (numericCallback !== undefined)
					validateNativeNumericSortCallback(numericCallback, compiler.native.functions);
				w.u8(
					numericCallback === undefined
						? 0
						: (numericCallback.operation === "sort" ? 1 : 2) +
								(numericCallback.viaCall ? 2 : 0),
				);
				if (numericCallback !== undefined) {
					w.i32(numericCallback.functionIndex);
					w.i32(numericCallback.entryId);
				}

				w.u8(
					(plan.directFunctionCall === true ? 1 : 0) |
						(guardedOperation === "Array.prototype.push" ? 2 : 0) |
						(guardedOperation === "String.prototype.charCodeAt" ? 4 : 0) |
						(plan.directStringCharCodeAtPosition === "inBounds" ? 32 : 0) |
						(guardedDependency?.kind === "world" ? 64 : 0) |
						(plan.exactCollectionReceiver === undefined ? 0 : 128),
				);
				w.u8(taggedGuardedBuiltinOperation(guardedOperation));
			} else if (plan.kind === "construct" && instruction.opcode === "CONSTRUCT") {
				if (
					!Number.isInteger(plan.directFunctionIndex) ||
					plan.directFunctionIndex < 0 ||
					plan.directFunctionIndex >= def.functions.length ||
					plan.directFunctionIndex !== instruction.exactFunctionIndex
				) {
					throw new RangeError("program-image-codec: invalid direct CONSTRUCT target");
				}
				w.u8(2);
				w.i32(plan.directFunctionIndex);
			} else if (
				plan.kind === "fresh-dense-reserve" &&
				instruction.opcode === "CREATE_ARRAY"
			) {
				if (!Number.isInteger(plan.length) || plan.length < 1 || plan.length > 65_536) {
					throw new RangeError(
						"program-image-codec: invalid indexed-fill reserve metadata",
					);
				}
				w.u8(12);
				w.i32(plan.length);
			} else if (
				plan.kind === "exact-array-length" &&
				(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
					instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
			) {
				if (
					String.fromCharCode(...(def.stringConstants[instruction.stringIndex] ?? [])) !==
					"length"
				) {
					throw new RangeError("program-image-codec: invalid exact Array length hint");
				}
				w.u8(14);
			} else if (
				plan.kind === "exact-contained-array-element" &&
				instruction.opcode === "LOAD_PROPERTY"
			) {
				w.u8(15);
			} else if (
				plan.kind === "exact-packed-rest-array-element" &&
				instruction.opcode === "LOAD_PROPERTY"
			) {
				if (typeof plan.indexIsUint32 !== "boolean") {
					throw new RangeError("program-image-codec: invalid packed rest index metadata");
				}
				w.u8(19);
				w.u8(plan.indexIsUint32 ? 1 : 0);
			} else if (
				plan.kind === "exact-typed-array-element" &&
				(instruction.opcode === "LOAD_PROPERTY" ||
					instruction.opcode === "STORE_PROPERTY")
			) {
				w.u8(16);
				w.u8(taggedNumericTypedArrayKind(plan.elementKind));
			} else if (
				plan.kind === "contained-fixed-typed-array-element" &&
				(instruction.opcode === "LOAD_PROPERTY" ||
					instruction.opcode === "STORE_PROPERTY")
			) {
				w.u8(17);
				w.u8(taggedNumericTypedArrayKind(plan.elementKind));
				w.u8(plan.inBounds ? 1 : 0);
			} else if (
				plan.kind === "contained-fixed-typed-array-length" &&
				(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
					instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
			) {
				if (
					String.fromCharCode(...(def.stringConstants[instruction.stringIndex] ?? [])) !==
					"length"
				) {
					throw new RangeError(
						"program-image-codec: invalid contained TypedArray length hint",
					);
				}
				w.u8(18);
			} else if (
				plan.kind === "primitive-string-length" &&
				instruction.opcode === "LOAD_PROPERTY_STATIC"
			) {
				if (
					String.fromCharCode(...(def.stringConstants[instruction.stringIndex] ?? [])) !==
					"length"
				) {
					throw new RangeError(
						"program-image-codec: invalid primitive-String length hint",
					);
				}
				w.u8(11);
			} else if (
				plan.kind === "exact-own-slot" &&
				(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
					instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" ||
					instruction.opcode === "STORE_PROPERTY_STATIC" ||
					instruction.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT")
			) {
				if (
					!Number.isSafeInteger(plan.slot) ||
					plan.slot < 0 ||
					plan.slot > 0xffff_ffff
				) {
					throw new RangeError("program-image-codec: invalid exact own slot");
				}
				w.u8(13);
				w.u32(plan.slot);
			} else if (
				plan.kind === "unsigned-arithmetic" &&
				instruction.opcode === "BINARY" &&
				["+", "-", "*", "%"].includes(instruction.operator)
			) {
				w.u8(18);
			} else if (
				plan.kind === "exact-builtin-input-kinds" &&
				instruction.opcode === "CALL_KNOWN" &&
				!instruction.construct &&
				instruction.argumentMode === undefined
			) {
				if (
					!compilerBuiltinInputKindsAreValid(
						plan.inputKindMasks,
						instruction.arguments.length + 1,
					)
				)
					throw new RangeError("program-image-codec: invalid builtin input kind masks");
				w.u8(19);
				for (const mask of plan.inputKindMasks) w.u8(mask);
			} else if (
				plan.kind === "exact-operator-input-kinds" &&
				(instruction.opcode === "BINARY" || instruction.opcode === "UNARY")
			) {
				if (
					!compilerOperatorInputKindsHaveExactNativeSemantics(
						instruction.opcode.toLowerCase(),
						instruction.operator,
						plan.inputKindMasks,
					)
				) {
					throw new RangeError("program-image-codec: invalid exact binary kind masks");
				}
				w.u8(17);
				w.u8(plan.inputKindMasks[0]);
				if (plan.inputKindMasks.length === 2) w.u8(plan.inputKindMasks[1]);
			} else {
				throw new RangeError(
					"program-image-codec: native instruction plan opcode mismatch",
				);
			}
		}

		const regions = [...native.specializations];
		if (!vmRegionActionsAreCurrent(regions, native.regionActions)) {
			throw new RangeError("program-image-codec: stale native region actions");
		}
		w.u32(regions.length);
		const claimedRegionInstructions = new Set<number>();
		for (const region of regions) {
			validateRegion(
				fn,
				region,
				claimedRegionInstructions,
				def.stringConstants,
				native.instructions,
				native.registerRepresentations,
			);
			const kindTag = coreRegionStrategy(region.kind).artifactTag;
			const representationTag = kindTag;
			const materializationTag =
				region.license.materialization === "none"
					? 0
					: region.license.materialization === "on-demand"
						? 1
						: 2;
			const { dependencyMask, obligationMask } =
				region.kind === "string-split-cursor"
					? stringSplitCursorGuardMasks(region.license)
					: region.kind === "string-split-projection"
						? stringSplitProjectionGuardMasks(region.license)
						: region.kind === "regexp-exec-projection"
							? regexpExecProjectionGuardMasks(region.license)
							: region.kind === "regexp-iterator-projection"
								? regexpIteratorProjectionGuardMasks(region.license)
								: region.kind === "string-slice-number"
									? stringSliceNumberGuardMasks(region.license)
									: region.kind === "string-char-code-at-chain"
										? stringCharCodeAtChainGuardMasks(region.license)
										: region.kind === "builtin-collection-call-chain"
											? builtinCollectionCallChainGuardMasks(region.license)
											: region.kind === "iterator-entry-pair-virtualization"
												? iteratorEntryPairGuardMasks(region.license)
												: region.kind === "stack-object-plan"
													? stackObjectPlanGuardMasks(region.license)
													: region.kind === "iterator-result-virtualization"
														? { dependencyMask: 0, obligationMask: 3 }
														: { dependencyMask: 0, obligationMask: 1 };
			w.u8(kindTag);
			w.u8(region.composition === "overlay" ? 1 : 0);
			w.i32Array([...region.anchors]);
			w.i32Array([...region.claimedIps]);
			w.i32Array([...region.controlFlow.ordinaryBlockIps]);
			w.i32Array([...region.controlFlow.exceptionalHandlerIps]);
			w.u32(region.cost.score);
			w.u32(region.cost.metadataOperations);
			w.u8(representationTag);
			w.u8(region.license.genericTwin === "retained" ? 1 : 0);
			w.u8(materializationTag);
			w.u8(dependencyMask);
			w.u8(obligationMask);
			w.u8(
				region.license.admission.mode === "stable"
					? 1
					: region.license.admission.mode === "capture"
						? 2
						: 0,
			);
			w.i32(region.license.admission.anchorIp);
			switch (region.kind) {
				case "indexed-length-loop":
					w.u8(region.runtimeGuard === "array-or-numeric-typed-array" ? 1 : 0);
					w.u32(region.sites.length);
					for (const site of region.sites) {
						w.i32(site.loadIp);
						w.i32(site.comparisonIp);
						w.u8(site.lengthPosition);
						w.u32(site.elements.length);
						for (const element of site.elements) {
							w.i32(element.ip);
							w.u8(element.kind === "load" ? 1 : 2);
							w.u8(element.arrayIndexIsUint32 ? 1 : 0);
						}
					}
					break;
				case "string-split-cursor":
					w.i32(region.propertyIp);
					writePropertyPlacement(w, region.propertyPlacement);
					w.u8(region.splitIdentity === "authority-invariant" ? 1 : 0);
					w.u8(region.trimIdentity === "authority-invariant" ? 1 : 0);
					w.i32(region.callee);
					w.i32(region.receiver);
					w.i32(region.separator);
					w.i32Array([...region.resultRegisters]);
					w.i32(region.index);
					w.i32(region.elementIp);
					w.i32(region.trimPropertyIp);
					w.i32(region.trimIcIndex);
					w.i32(region.trimCallIp);
					w.i32Array([...region.primitiveStringLengthIps]);
					w.i32(region.exitIp);
					break;
				case "string-split-projection":
					w.i32(region.propertyIp);
					writePropertyPlacement(w, region.propertyPlacement);
					w.u8(region.splitIdentity === "authority-invariant" ? 1 : 0);
					w.i32(region.callIp);
					w.i32(region.callee);
					w.i32(region.receiver);
					w.i32(region.separatorIp);
					w.i32(region.separatorStringIndex);
					w.i32Array([...region.resultRegisters]);
					w.u32(region.loads.length);
					for (const load of region.loads) {
						w.i32(load.ip);
						w.u8(load.kind === "element" ? 1 : 2);
						w.i32(load.kind === "element" ? load.keyIp : -1);
						w.i32(load.kind === "element" ? load.index : -1);
						w.i32(load.dst);
					}
					break;
				case "numeric-fusion":
					w.u8(region.runtimeGuard === "number-operands" ? 1 : 0);
					w.u32(region.pairs.length);
					for (const pair of region.pairs) {
						w.i32(pair.firstIp);
						w.i32(pair.finishIp);
						w.u8(pair.firstUsePosition);
					}
					break;
				case "regexp-exec-projection":
					w.i32(region.propertyIp);
					writePropertyPlacement(w, region.propertyPlacement);
					w.i32(region.callIp);
					w.u8(region.lockedFreshLiteral ? 1 : 0);
					w.i32(region.lockedLiteral?.constructorIntrinsicIp ?? -1);
					w.i32(region.lockedLiteral?.constructIp ?? -1);
					w.i32(region.callee);
					w.i32(region.receiver);
					w.i32(region.input);
					w.i32(region.result);
					w.i32Array([...region.resultRegisters]);
					w.u32(region.nullChecks.length);
					for (const check of region.nullChecks) {
						w.i32(check.comparisonIp);
						w.i32(check.nullIp);
					}
					w.u8(region.lastIndexEffect === "retained-call-twin" ? 1 : 0);
					w.u32(region.loads.length);
					for (const load of region.loads) {
						w.i32(load.ip);
						w.i32(load.keyIp);
						w.i32(load.captureIndex);
						w.i32(load.dst);
						const consumer = load.consumer;
						w.u8(
							consumer === undefined
								? 0
								: consumer.kind === "length"
									? 1
									: consumer.kind === "charCodeAtZero"
										? 2
										: consumer.kind === "number"
											? 3
											: 4,
						);
						if (consumer?.kind === "length") {
							w.i32(consumer.propertyIp);
						} else if (consumer?.kind === "charCodeAtZero") {
							w.i32(consumer.propertyIp);
							w.i32(consumer.callIp);
							w.i32(consumer.zeroIp ?? -1);
							w.u8(consumer.methodIdentity === "authority-invariant" ? 1 : 0);
						} else if (consumer?.kind === "number") {
							w.i32(consumer.intrinsicIp);
							w.i32(consumer.callIp);
						} else if (consumer?.kind === "asciiCaseLength") {
							w.i32(consumer.upperPropertyIp);
							w.i32(consumer.upperCallIp);
							w.i32(consumer.lowerPropertyIp);
							w.i32(consumer.lowerIcIndex);
							w.i32(consumer.lowerCallIp);
							w.i32Array([...consumer.resultMoveIps]);
							w.i32(consumer.lengthPropertyIp);
							w.u8(consumer.methodIdentity === "authority-invariant" ? 1 : 0);
						}
					}
					break;
				case "regexp-iterator-projection":
					w.i32(region.stepIp);
					w.i32(region.doneBranchIp);
					w.i32(region.exitIp);
					w.i32(region.iterator);
					w.i32(region.next);
					w.i32(region.value);
					w.i32(region.done);
					w.i32Array([...region.resultRegisters]);
					w.u8(region.statefulEffect === "iterator-last-index-retained-step" ? 1 : 0);
					w.u8(region.runtimeGuard === "exact-brand-next-realm-regexp" ? 1 : 0);
					w.u32(region.loads.length);
					for (const load of region.loads) {
						w.i32(load.ip);
						w.i32(load.keyIp);
						w.i32(load.captureIndex);
						w.i32(load.dst);
						w.i32(load.numberIntrinsicIp);
						w.i32(load.numberCallIp);
					}
					break;
				case "string-slice-number":
					w.i32(region.propertyIp);
					writePropertyPlacement(w, region.propertyPlacement);
					w.u8(region.builtinIdentities === "authority-invariant" ? 1 : 0);
					w.i32(region.sliceCallIp);
					w.i32(region.sliceStartIp);
					w.i32(region.numberIntrinsicIp);
					w.i32(region.numberCallIp);
					w.i32(region.numberCallee);
					w.i32(region.receiver);
					w.f64(region.sliceStart);
					w.i32(region.result);
					break;
				case "string-char-code-at-chain":
					w.i32(region.propertyIp);
					w.i32(region.callIp);
					w.u8(region.methodIdentity === "authority-invariant" ? 1 : 0);
					w.u8(region.runtimeGuard === "primitive-string-number-position" ? 1 : 0);
					w.u8(region.evaluationOrder === "capture-property-before-arguments" ? 1 : 0);
					w.i32(region.propertyIcIndex);
					w.i32(region.callee);
					w.i32(region.receiver);
					w.i32(region.result);
					break;
				case "builtin-collection-call-chain":
					w.i32(region.propertyIp);
					w.i32(region.callIp);
					w.u8(taggedGuardedBuiltinOperation(region.operation));
					w.u8(region.runtimeGuard === "exact-collection-method" ? 1 : 0);
					w.u8(region.evaluationOrder === "capture-property-before-arguments" ? 1 : 0);
					w.i32(region.propertyIcIndex);
					w.i32(region.callee);
					w.i32(region.receiver);
					w.i32(region.result);
					break;
				case "array-values-iterator-cursor":
				case "string-iterator-cursor":
				case "typed-array-iterator-cursor":
				case "map-iterator-cursor":
				case "set-iterator-cursor":
					w.i32(region.initializeIp);
					w.i32Array([...region.stepIps]);
					w.i32(region.iterator);
					w.i32(region.next);
					w.u8(region.runtimeGuard === "exact-iterator-brand-next-target" ? 1 : 0);
					w.u8(region.stateSynchronization === "authoritative-language-object" ? 1 : 0);
					w.u8(region.suspension === "forbidden" ? 1 : 0);
					break;
				case "iterator-result-virtualization":
					w.i32Array([...region.stepIps]);
					w.u8(region.runtimeGuard === "exact-builtin-iterator-next" ? 1 : 0);
					w.u8(region.correspondence === "done-value-observation" ? 1 : 0);
					w.u8(region.fallback === "materialize-result-then-observe" ? 1 : 0);
					break;
				case "iterator-entry-pair-virtualization":
					w.i32(region.cursorInitializeIp);
					w.i32(region.outerStepIp);
					w.i32(region.innerInitializeIp);
					w.i32Array([...region.innerStepIps]);
					w.i32Array([...region.innerCloseIps]);
					w.u8(region.runtimeGuard === "exact-entry-pair-cursor" ? 1 : 0);
					w.u8(region.correspondence === "entry-pair-elements" ? 1 : 0);
					w.u8(region.stateSynchronization === "authoritative-language-object" ? 1 : 0);
					w.u8(region.fallback === "materialize-entry-pair-then-iterate" ? 1 : 0);
					break;
				case "stack-object-plan":
					w.u32(region.sites.length);
					for (const site of region.sites) {
						w.i32(site.allocationIp);
						w.u8(site.mode === "elided" ? 0 : 1);
						w.i32(site.slotCount);
						w.u32(site.accesses.length);
						for (const access of site.accesses) {
							w.i32(access.ip);
							w.i32(access.slot);
						}
						w.i32(site.inheritedAccessIp ?? -1);
						w.u32(site.materializations.length);
						for (const materialization of site.materializations) {
							w.i32(materialization.ip);
							w.u8(1);
						}
					}
					break;
			}
		}
	}
}

function validateRegionEnvelope(
	fn: BytecodeFunction,
	region: VmRegion,
	claimed: Set<number>,
): void {
	const instructionIpValid = (ip: number) =>
		Number.isSafeInteger(ip) && ip >= 0 && ip < fn.instructions.length;
	if (
		region.anchors.length === 0 ||
		region.anchors.length > MAX_REGION_ANCHORS ||
		new Set(region.anchors).size !== region.anchors.length ||
		region.anchors.some((ip) => !instructionIpValid(ip)) ||
		region.claimedIps.length === 0 ||
		region.claimedIps.length > MAX_REGION_CLAIMS ||
		new Set(region.claimedIps).size !== region.claimedIps.length ||
		region.claimedIps.some(
			(ip) =>
				!instructionIpValid(ip) || (region.composition !== "overlay" && claimed.has(ip)),
		) ||
		region.anchors.some((ip) => !region.claimedIps.includes(ip)) ||
		region.controlFlow.ordinaryBlockIps.length === 0 ||
		region.controlFlow.ordinaryBlockIps.length > MAX_REGION_ORDINARY_BLOCKS ||
		new Set(region.controlFlow.ordinaryBlockIps).size !==
			region.controlFlow.ordinaryBlockIps.length ||
		region.controlFlow.ordinaryBlockIps.some((ip) => !instructionIpValid(ip)) ||
		region.controlFlow.exceptionalHandlerIps.length > MAX_REGION_ORDINARY_BLOCKS ||
		new Set(region.controlFlow.exceptionalHandlerIps).size !==
			region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some(
			(ip) =>
				!instructionIpValid(ip) ||
				region.controlFlow.ordinaryBlockIps.includes(ip) ||
				!fn.handlers.some((handler) => handler.handlerIp === ip),
		) ||
		(region.kind !== "regexp-iterator-projection" &&
			region.kind !== "string-slice-number" &&
			region.kind !== "string-char-code-at-chain" &&
			region.kind !== "builtin-collection-call-chain" &&
			region.kind !== "iterator-entry-pair-virtualization" &&
			region.kind !== "iterator-result-virtualization" &&
			region.kind !== "array-values-iterator-cursor" &&
			region.kind !== "string-iterator-cursor" &&
			region.kind !== "typed-array-iterator-cursor" &&
			region.kind !== "map-iterator-cursor" &&
			region.kind !== "set-iterator-cursor" &&
			region.controlFlow.exceptionalHandlerIps.length !== 0) ||
		!Number.isSafeInteger(region.cost.score) ||
		region.cost.score <= 0 ||
		region.cost.score > 0xffff_ffff ||
		!Number.isSafeInteger(region.cost.metadataOperations) ||
		region.cost.metadataOperations <= 0 ||
		region.cost.metadataOperations > MAX_REGION_CLAIMS ||
		!instructionIpValid(region.license.admission.anchorIp) ||
		!region.claimedIps.includes(region.license.admission.anchorIp)
	) {
		throw new RangeError("program-image-codec: invalid region envelope");
	}
}

function nativeCallPlanAt(
	plans: ReadonlyArray<NativeInstructionPlan | undefined>,
	ip: number,
): Extract<NativeInstructionPlan, { kind: "call" }> | undefined {
	const plan = plans[ip];
	return plan?.kind === "call" ? plan : undefined;
}

function validateRegion(
	fn: BytecodeFunction,
	region: VmRegion,
	claimed: Set<number>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
	registerRepresentations: ReadonlyArray<VmRegisterRepresentation>,
): void {
	validateRegionEnvelope(fn, region, claimed);
	switch (region.kind) {
		case "indexed-length-loop":
			validateIndexedLengthLoopRegion(
				fn,
				region,
				stringConstants,
				registerRepresentations,
			);
			break;
		case "string-split-cursor":
			validateStringSplitCursorRegion(fn, region, nativeInstructions);
			break;
		case "string-split-projection":
			validateStringSplitProjectionRegion(
				fn,
				region,
				stringConstants,
				nativeInstructions,
			);
			break;
		case "regexp-exec-projection":
			validateRegExpExecProjectionRegion(fn, region, stringConstants, nativeInstructions);
			break;
		case "regexp-iterator-projection":
			validateRegExpIteratorProjectionRegion(fn, region);
			break;
		case "string-slice-number":
			validateStringSliceNumberRegion(fn, region, stringConstants, nativeInstructions);
			break;
		case "string-char-code-at-chain":
			validateStringCharCodeAtChainRegion(
				fn,
				region,
				stringConstants,
				nativeInstructions,
			);
			break;
		case "builtin-collection-call-chain":
			validateBuiltinCollectionCallChainRegion(
				fn,
				region,
				stringConstants,
				nativeInstructions,
			);
			break;
		case "array-values-iterator-cursor":
		case "string-iterator-cursor":
		case "typed-array-iterator-cursor":
		case "map-iterator-cursor":
		case "set-iterator-cursor":
			validateIteratorCursorRegion(fn, region);
			break;
		case "iterator-result-virtualization":
			validateIteratorResultVirtualizationRegion(fn, region);
			break;
		case "iterator-entry-pair-virtualization":
			validateIteratorEntryPairVirtualizationRegion(fn, region);
			break;
		case "stack-object-plan":
			validateStackObjectPlanRegion(fn, region);
			break;
		case "numeric-fusion":
			validateNumericFusionRegion(fn, region);
			break;
	}
	if (region.composition !== "overlay") {
		for (const ip of region.claimedIps) claimed.add(ip);
	}
}

function validateNumericFusionRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "numeric-fusion" }>,
): void {
	const payloadIps = region.pairs.flatMap((pair) => [pair.firstIp, pair.finishIp]);
	const startOperators = new Set([
		"+",
		"-",
		"*",
		"/",
		"%",
		"&",
		"|",
		"^",
		"<<",
		">>",
		">>>",
	]);
	const finishOperators = new Set([
		...startOperators,
		"<",
		"<=",
		">",
		">=",
		"==",
		"!=",
		"===",
		"!==",
	]);
	if (
		region.composition !== "overlay" ||
		region.license.guard.dependencies.length !== 0 ||
		region.license.guard.obligations.length !== 1 ||
		region.license.guard.obligations[0] !== "fallback" ||
		region.license.genericTwin !== "retained" ||
		region.license.materialization !== "none" ||
		region.representation !== "binary-pairs-f64" ||
		region.runtimeGuard !== "number-operands" ||
		region.pairs.length === 0 ||
		region.pairs.length > 32 ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.pairs[0]!.firstIp ||
		region.anchors[1] !== region.pairs[0]!.finishIp ||
		new Set(payloadIps).size !== payloadIps.length ||
		payloadIps.length !== region.claimedIps.length ||
		payloadIps.some((ip) => !region.claimedIps.includes(ip)) ||
		region.cost.score !== region.pairs.length ||
		region.cost.metadataOperations !== payloadIps.length ||
		region.pairs.some((pair) => {
			const first = fn.instructions[pair.firstIp];
			const finish = fn.instructions[pair.finishIp];
			return (
				first?.opcode !== "BINARY" ||
				finish?.opcode !== "BINARY" ||
				!startOperators.has(first.operator) ||
				!finishOperators.has(finish.operator) ||
				(pair.firstUsePosition !== 1 && pair.firstUsePosition !== 2) ||
				(pair.firstUsePosition === 1 ? finish.left : finish.right) !== first.dst ||
				pair.firstIp >= pair.finishIp
			);
		})
	) {
		throw new RangeError("program-image-codec: invalid numeric-fusion region");
	}
}

function bytecodeInstructionDominates(
	fn: BytecodeFunction,
	dominatorIp: number,
	dominatedIp: number,
): boolean {
	const reachable = (skippedIp: number | undefined): boolean => {
		const pending = [0];
		const visited = new Set<number>();
		while (pending.length > 0) {
			const ip = pending.pop()!;
			if (ip === skippedIp || visited.has(ip)) continue;
			if (ip === dominatedIp) return true;
			visited.add(ip);
			const instruction = fn.instructions[ip];
			if (instruction === undefined) continue;
			if (instruction.opcode === "JUMP") {
				pending.push(instruction.targetIp);
				continue;
			}
			if (instruction.opcode === "JUMP_IF") {
				pending.push(instruction.targetIp, ip + 1);
				continue;
			}
			if (
				instruction.opcode !== "RETURN" &&
				instruction.opcode !== "THROW" &&
				instruction.opcode !== "TERMINAL_YIELD"
			)
				pending.push(ip + 1);
		}
		return false;
	};
	return dominatorIp !== dominatedIp && reachable(undefined) && !reachable(dominatorIp);
}

function validateIndexedLengthLoopRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "indexed-length-loop" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	registerRepresentations: ReadonlyArray<VmRegisterRepresentation>,
): void {
	const payloadIps = region.sites.flatMap(({ loadIp, comparisonIp, elements }) => [
		loadIp,
		comparisonIp,
		...elements.map(({ ip }) => ip),
	]);
	const elementCount = region.sites.reduce(
		(total, site) => total + site.elements.length,
		0,
	);
	if (
		region.composition !== undefined ||
		region.license.guard.dependencies.length !== 0 ||
		region.license.guard.obligations.length !== 1 ||
		region.license.guard.obligations[0] !== "fallback" ||
		region.license.genericTwin !== "retained" ||
		region.license.materialization !== "none" ||
		region.representation !== "live-indexed-length-loops" ||
		region.runtimeGuard !== "array-or-numeric-typed-array" ||
		region.sites.length === 0 ||
		region.sites.length > 32 ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.sites[0]!.loadIp ||
		region.anchors[1] !== region.sites[0]!.comparisonIp ||
		new Set(payloadIps).size !== payloadIps.length ||
		payloadIps.length !== region.claimedIps.length ||
		payloadIps.some((ip) => !region.claimedIps.includes(ip)) ||
		region.cost.score !== region.sites.length * 4 + elementCount * 3 ||
		region.cost.metadataOperations !== payloadIps.length ||
		region.sites.some((site) => {
			const { loadIp, comparisonIp, lengthPosition, elements } = site;
			const load = fn.instructions[loadIp];
			const comparison = fn.instructions[comparisonIp];
			const other =
				comparison?.opcode === "BINARY"
					? lengthPosition === 1
						? comparison.right
						: comparison.left
					: -1;
			const length =
				comparison?.opcode === "BINARY"
					? lengthPosition === 1
						? comparison.left
						: comparison.right
					: -1;
			return (
				load?.opcode !== "LOAD_PROPERTY_STATIC" ||
				String.fromCharCode(...(stringConstants[load.stringIndex] ?? [])) !== "length" ||
				comparison?.opcode !== "BINARY" ||
				!["<", "<=", ">", ">=", "==", "!=", "===", "!=="].includes(comparison.operator) ||
				(lengthPosition !== 1 && lengthPosition !== 2) ||
				length !== load.dst ||
				!bytecodeInstructionDominates(fn, loadIp, comparisonIp) ||
				(registerRepresentations[other] !== "int32" &&
					registerRepresentations[other] !== "number") ||
				elements.length > 8 ||
				elements.some(({ ip, kind, arrayIndexIsUint32 }) => {
					const element = fn.instructions[ip];
					return (
						ip <= comparisonIp ||
						typeof arrayIndexIsUint32 !== "boolean" ||
						(arrayIndexIsUint32 &&
							!(
								(lengthPosition === 1 && comparison.operator === ">") ||
								(lengthPosition === 2 && comparison.operator === "<")
							)) ||
						(kind === "load"
							? element?.opcode !== "LOAD_PROPERTY"
							: element?.opcode !== "STORE_PROPERTY") ||
						(element?.opcode === "LOAD_PROPERTY" || element?.opcode === "STORE_PROPERTY"
							? element.object !== load.object || element.key !== other
							: true)
					);
				})
			);
		})
	) {
		throw new RangeError("program-image-codec: invalid indexed-length-loop region");
	}
}

function validateStackObjectPlanRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "stack-object-plan" }>,
): void {
	const { dependencyMask } = stackObjectPlanGuardMasks(region.license);
	const payload = new Set<number>();
	const allocationIps = new Set<number>();
	let inheritedAccessCount = 0;
	let materializationCount = 0;
	let totalSlots = 0;
	let valid =
		region.representation === "activation-local-fixed-shape-objects" &&
		region.sites.length > 0 &&
		region.sites.length <= 8 &&
		region.anchors.length === region.sites.length &&
		region.controlFlow.exceptionalHandlerIps.length === 0;
	for (let siteIndex = 0; siteIndex < region.sites.length; siteIndex++) {
		const site = region.sites[siteIndex]!;
		const allocation = fn.instructions[site.allocationIp];
		if (
			allocationIps.has(site.allocationIp) ||
			(site.mode !== "elided" && site.mode !== "activation-local") ||
			(site.mode === "elided" &&
				(site.accesses.length !== 0 ||
					site.inheritedAccessIp !== undefined ||
					site.materializations.length !== 0)) ||
			region.anchors[siteIndex] !== site.allocationIp ||
			(allocation?.opcode !== "CREATE_OBJECT" &&
				allocation?.opcode !== "CREATE_OBJECT_SHAPED") ||
			(allocation.opcode === "CREATE_OBJECT"
				? site.slotCount !== 0
				: allocation.count !== site.slotCount) ||
			site.slotCount < 0 ||
			site.slotCount > 256
		) {
			valid = false;
		}
		allocationIps.add(site.allocationIp);
		totalSlots += site.slotCount;
		payload.add(site.allocationIp);
		for (const access of site.accesses) {
			const instruction = fn.instructions[access.ip];
			if (
				(instruction?.opcode !== "LOAD_PROPERTY_STATIC" &&
					instruction?.opcode !== "STORE_PROPERTY_STATIC" &&
					instruction?.opcode !== "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" &&
					instruction?.opcode !== "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT") ||
				access.slot < 0 ||
				access.slot >= site.slotCount ||
				allocation?.opcode !== "CREATE_OBJECT_SHAPED" ||
				allocation.keyStringIndices[access.slot] !== instruction.stringIndex ||
				payload.has(access.ip)
			) {
				valid = false;
			}
			payload.add(access.ip);
		}
		if (site.inheritedAccessIp !== undefined) {
			inheritedAccessCount++;
			if (
				fn.instructions[site.inheritedAccessIp]?.opcode !== "LOAD_PROPERTY_STATIC" ||
				payload.has(site.inheritedAccessIp)
			) {
				valid = false;
			}
			payload.add(site.inheritedAccessIp);
		}
		for (const materialization of site.materializations) {
			materializationCount++;
			const instruction = fn.instructions[materialization.ip];
			if (
				materialization.kind !== "return" ||
				instruction?.opcode !== "RETURN" ||
				payload.has(materialization.ip)
			) {
				valid = false;
			}
			payload.add(materialization.ip);
		}
	}
	if (
		totalSlots > 256 ||
		(inheritedAccessCount === 0 ? dependencyMask !== 0 : dependencyMask === 0) ||
		(region.license.materialization === "on-demand") !==
			(materializationCount > 0 || inheritedAccessCount > 0) ||
		region.cost.metadataOperations !== payload.size ||
		payload.size !== region.claimedIps.length ||
		region.claimedIps.some((ip) => !payload.has(ip)) ||
		region.claimedIps.some((ip) => !region.controlFlow.ordinaryBlockIps.includes(ip))
	) {
		valid = false;
	}
	if (!valid)
		throw new RangeError("program-image-codec: invalid stack-object plan region");
}

function validateStringSliceNumberRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "string-slice-number" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
): void {
	stringSliceNumberGuardMasks(region.license);
	const property = fn.instructions[region.propertyIp];
	const sliceCall = fn.instructions[region.sliceCallIp];
	const sliceCallPlan = nativeCallPlanAt(nativeInstructions, region.sliceCallIp);
	const sliceStartInstruction = fn.instructions[region.sliceStartIp];
	const numberIntrinsic = fn.instructions[region.numberIntrinsicIp];
	const numberCall = fn.instructions[region.numberCallIp];
	const numberArgument =
		(numberCall?.opcode === "CALL" || numberCall?.opcode === "CALL_KNOWN") &&
		numberCall.arguments[0] !== undefined
			? decodeVmValueOperand(numberCall.arguments[0])
			: undefined;
	const expectedBuiltinIdentities =
		sliceCall?.opcode === "CALL_KNOWN" ||
		(sliceCall?.opcode === "CALL" &&
			sliceCallPlan?.guardedBuiltinCall !== undefined &&
			vmGuardIsWorldInvariant(sliceCallPlan.guardedBuiltinCall.guard))
			? "authority-invariant"
			: "runtime-guarded";
	const payload = new Set(
		[
			region.propertyIp,
			region.sliceCallIp,
			region.sliceStartIp,
			region.numberIntrinsicIp,
			region.numberCallIp,
		].filter((ip) => ip >= 0),
	);
	const activeHandlers = new Set<number>();
	for (const ip of region.claimedIps) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp) {
				activeHandlers.add(handler.handlerIp);
			}
		}
	}
	if (
		region.representation !== "primitive-string-span-number" ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.sliceCallIp ||
		region.anchors[1] !== region.numberCallIp ||
		(sliceCall?.opcode !== "CALL" && sliceCall?.opcode !== "CALL_KNOWN") ||
		(sliceCall.opcode === "CALL_KNOWN"
			? sliceCall.operation !== "String.prototype.slice" ||
				sliceCall.construct ||
				sliceCall.argumentMode !== undefined ||
				region.propertyIp !== -1
			: property?.opcode !== "LOAD_PROPERTY_STATIC" ||
				String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) !==
					"slice" ||
				sliceCallPlan?.guardedBuiltinCall?.operation !== "String.prototype.slice" ||
				property.dst !== sliceCall.callee ||
				property.object !== sliceCall.thisValue) ||
		sliceCall.arguments.length !== 1 ||
		(sliceStartInstruction?.opcode !== "CREATE_NUMBER" &&
			sliceStartInstruction?.opcode !== "CREATE_F64") ||
		!Object.is(sliceStartInstruction.value, region.sliceStart) ||
		!Number.isFinite(region.sliceStart) ||
		(numberCall?.opcode !== "CALL" && numberCall?.opcode !== "CALL_KNOWN") ||
		(numberCall.opcode === "CALL_KNOWN"
			? numberCall.operation !== "Number" ||
				numberCall.construct ||
				numberCall.argumentMode !== undefined ||
				region.numberIntrinsicIp !== -1 ||
				region.numberCallee !== -1
			: numberIntrinsic?.opcode !== "LOAD_INTRINSIC" ||
				numberIntrinsic.intrinsic !== "Number" ||
				numberCall.callee !== numberIntrinsic.dst ||
				numberCall.callee !== region.numberCallee) ||
		numberCall.arguments.length !== 1 ||
		numberArgument?.kind !== "register" ||
		numberArgument.register !== sliceCall.dst ||
		region.builtinIdentities !== expectedBuiltinIdentities ||
		!propertyPlacementHolds(
			fn,
			region.propertyPlacement,
			region.propertyIp,
			region.sliceCallIp,
		) ||
		(region.propertyPlacement === "call-fallback" &&
			region.builtinIdentities !== "authority-invariant") ||
		region.receiver !== sliceCall.thisValue ||
		region.result !== numberCall.dst ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip)) ||
		region.cost.metadataOperations !== payload.size ||
		payload.size !== region.claimedIps.length ||
		region.claimedIps.some((ip) => !payload.has(ip))
	) {
		throw new RangeError("program-image-codec: invalid String.slice Number region");
	}
}

function validateStringCharCodeAtChainRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "string-char-code-at-chain" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
): void {
	stringCharCodeAtChainGuardMasks(region.license);
	const property = fn.instructions[region.propertyIp];
	const call = fn.instructions[region.callIp];
	const callPlan = nativeCallPlanAt(nativeInstructions, region.callIp);
	const expectedMethodIdentity =
		callPlan?.guardedBuiltinCall !== undefined &&
		vmGuardIsWorldInvariant(callPlan.guardedBuiltinCall.guard)
			? "authority-invariant"
			: "runtime-guarded";
	const activeHandlers = new Set<number>();
	for (const ip of region.claimedIps) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp) {
				activeHandlers.add(handler.handlerIp);
			}
		}
	}
	if (
		region.representation !== "primitive-string-code-unit" ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.propertyIp ||
		region.anchors[1] !== region.callIp ||
		region.claimedIps.length !== 2 ||
		!region.claimedIps.includes(region.propertyIp) ||
		!region.claimedIps.includes(region.callIp) ||
		region.license.admission.anchorIp !== region.propertyIp ||
		property?.opcode !== "LOAD_PROPERTY_STATIC" ||
		String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) !==
			"charCodeAt" ||
		property.icIndex !== region.propertyIcIndex ||
		call?.opcode !== "CALL" ||
		callPlan?.guardedBuiltinCall?.operation !== "String.prototype.charCodeAt" ||
		call.arguments.length > 1 ||
		property.dst !== call.callee ||
		property.object !== call.thisValue ||
		region.propertyIp >= region.callIp ||
		region.methodIdentity !== expectedMethodIdentity ||
		region.runtimeGuard !== "primitive-string-number-position" ||
		region.evaluationOrder !== "capture-property-before-arguments" ||
		region.callee !== call.callee ||
		region.receiver !== call.thisValue ||
		region.result !== call.dst ||
		region.cost.score !== 12 ||
		region.cost.metadataOperations !== 2 ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip))
	) {
		throw new RangeError("program-image-codec: invalid String.charCodeAt chain region");
	}
}

function validateBuiltinCollectionCallChainRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "builtin-collection-call-chain" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
): void {
	builtinCollectionCallChainGuardMasks(region.license);
	const property = fn.instructions[region.propertyIp];
	const call = fn.instructions[region.callIp];
	const callPlan = nativeCallPlanAt(nativeInstructions, region.callIp);
	const activeHandlers = new Set<number>();
	for (const ip of region.claimedIps) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp)
				activeHandlers.add(handler.handlerIp);
		}
	}
	if (
		region.representation !== "captured-collection-method" ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.propertyIp ||
		region.anchors[1] !== region.callIp ||
		region.claimedIps.length !== 2 ||
		!region.claimedIps.includes(region.propertyIp) ||
		!region.claimedIps.includes(region.callIp) ||
		region.license.admission.anchorIp !== region.propertyIp ||
		property?.opcode !== "LOAD_PROPERTY_STATIC" ||
		String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) !==
			region.operation.split(".").at(-1) ||
		property.icIndex !== region.propertyIcIndex ||
		call?.opcode !== "CALL" ||
		callPlan?.guardedBuiltinCall?.operation !== region.operation ||
		property.dst !== call.callee ||
		property.object !== call.thisValue ||
		region.propertyIp >= region.callIp ||
		region.runtimeGuard !== "exact-collection-method" ||
		region.evaluationOrder !== "capture-property-before-arguments" ||
		region.callee !== call.callee ||
		region.receiver !== call.thisValue ||
		region.result !== call.dst ||
		region.cost.score !== 14 ||
		region.cost.metadataOperations !== 2 ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip))
	) {
		throw new RangeError("program-image-codec: invalid builtin collection chain region");
	}
}

type VmIteratorCursorRegion = Extract<
	VmRegion,
	{
		kind:
			| "array-values-iterator-cursor"
			| "string-iterator-cursor"
			| "typed-array-iterator-cursor"
			| "map-iterator-cursor"
			| "set-iterator-cursor";
	}
>;

function validateIteratorCursorRegion(
	fn: BytecodeFunction,
	region: VmIteratorCursorRegion,
): void {
	const expected = {
		"array-values-iterator-cursor": ["array-values-authoritative-cursor", "array-values"],
		"string-iterator-cursor": ["string-authoritative-cursor", "string"],
		"typed-array-iterator-cursor": [
			"typed-array-authoritative-cursor",
			"typed-array-values",
		],
		"map-iterator-cursor": ["map-authoritative-cursor", "map"],
		"set-iterator-cursor": ["set-authoritative-cursor", "set"],
	} as const;
	const [representation, protocol] = expected[region.kind];
	const initialize = fn.instructions[region.initializeIp];
	const payload = [region.initializeIp, ...region.stepIps];
	const activeHandlers = new Set<number>();
	for (const ip of payload) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp) {
				activeHandlers.add(handler.handlerIp);
			}
		}
	}
	if (
		fn.isGenerator ||
		fn.isAsync ||
		region.representation !== representation ||
		region.protocol !== protocol ||
		region.runtimeGuard !== "exact-iterator-brand-next-target" ||
		region.stateSynchronization !== "authoritative-language-object" ||
		region.suspension !== "forbidden" ||
		region.composition !== undefined ||
		region.license.guard.dependencies.length !== 0 ||
		region.license.guard.obligations.length !== 1 ||
		region.license.guard.obligations[0] !== "fallback" ||
		region.license.genericTwin !== "retained" ||
		region.license.materialization !== "none" ||
		region.license.admission.mode !== "stable" ||
		region.license.admission.anchorIp !== region.initializeIp ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.initializeIp ||
		region.anchors[1] !== region.stepIps[0] ||
		initialize?.opcode !== "GET_ITERATOR" ||
		initialize.iteratorDst !== region.iterator ||
		initialize.nextDst !== region.next ||
		region.stepIps.length === 0 ||
		region.stepIps.length > 32 ||
		new Set(payload).size !== payload.length ||
		payload.length !== region.claimedIps.length ||
		payload.some((ip) => !region.claimedIps.includes(ip)) ||
		region.stepIps.some((ip) => {
			const step = fn.instructions[ip];
			return (
				step?.opcode !== "ITERATOR_STEP" ||
				step.iterator !== region.iterator ||
				step.next !== region.next
			);
		}) ||
		region.cost.score !== region.stepIps.length * 8 ||
		region.cost.metadataOperations !== payload.length ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip))
	) {
		throw new RangeError(`program-image-codec: invalid ${region.kind} region`);
	}
}

function validateIteratorResultVirtualizationRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "iterator-result-virtualization" }>,
): void {
	const activeHandlers = new Set<number>();
	for (const ip of region.stepIps) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp) {
				activeHandlers.add(handler.handlerIp);
			}
		}
	}
	if (
		region.representation !== "virtual-iterator-result" ||
		region.composition !== "overlay" ||
		region.runtimeGuard !== "exact-builtin-iterator-next" ||
		region.correspondence !== "done-value-observation" ||
		region.fallback !== "materialize-result-then-observe" ||
		region.license.guard.dependencies.length !== 0 ||
		region.license.guard.obligations.length !== 2 ||
		region.license.guard.obligations[0] !== "fallback" ||
		region.license.guard.obligations[1] !== "materialize" ||
		region.license.genericTwin !== "retained" ||
		region.license.materialization !== "on-demand" ||
		region.license.admission.mode !== "stable" ||
		region.license.admission.anchorIp !== region.stepIps[0] ||
		region.anchors.length !== 1 ||
		region.anchors[0] !== region.stepIps[0] ||
		region.stepIps.length === 0 ||
		region.stepIps.length > 64 ||
		new Set(region.stepIps).size !== region.stepIps.length ||
		region.stepIps.length !== region.claimedIps.length ||
		region.stepIps.some(
			(ip) =>
				!region.claimedIps.includes(ip) ||
				fn.instructions[ip]?.opcode !== "ITERATOR_STEP",
		) ||
		region.cost.score !== region.stepIps.length * 6 ||
		region.cost.metadataOperations !== region.stepIps.length ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip))
	) {
		throw new RangeError(
			"program-image-codec: invalid iterator-result virtualization region",
		);
	}
}

function validateIteratorEntryPairVirtualizationRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "iterator-entry-pair-virtualization" }>,
): void {
	iteratorEntryPairGuardMasks(region.license);
	const cursorInitialize = fn.instructions[region.cursorInitializeIp];
	const outerStep = fn.instructions[region.outerStepIp];
	const innerInitialize = fn.instructions[region.innerInitializeIp];
	const payload = [
		region.cursorInitializeIp,
		region.outerStepIp,
		region.innerInitializeIp,
		...region.innerStepIps,
		...region.innerCloseIps,
	];
	const activeHandlers = new Set<number>();
	for (const ip of payload) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp)
				activeHandlers.add(handler.handlerIp);
		}
	}
	if (
		region.representation !== "virtual-iterator-entry-pair" ||
		region.composition !== "overlay" ||
		region.runtimeGuard !== "exact-entry-pair-cursor" ||
		region.correspondence !== "entry-pair-elements" ||
		region.stateSynchronization !== "authoritative-language-object" ||
		region.fallback !== "materialize-entry-pair-then-iterate" ||
		region.license.admission.anchorIp !== region.outerStepIp ||
		region.anchors.length !== 2 ||
		region.anchors[0] !== region.outerStepIp ||
		region.anchors[1] !== region.innerInitializeIp ||
		region.innerStepIps.length !== 2 ||
		region.innerCloseIps.length > 8 ||
		new Set(payload).size !== payload.length ||
		payload.length !== region.claimedIps.length ||
		payload.some((ip) => !region.claimedIps.includes(ip)) ||
		cursorInitialize?.opcode !== "GET_ITERATOR" ||
		outerStep?.opcode !== "ITERATOR_STEP" ||
		outerStep.iterator !== cursorInitialize.iteratorDst ||
		outerStep.next !== cursorInitialize.nextDst ||
		innerInitialize?.opcode !== "GET_ITERATOR" ||
		innerInitialize.source !== outerStep.valueDst ||
		region.innerStepIps.some((ip) => {
			const step = fn.instructions[ip];
			return (
				step?.opcode !== "ITERATOR_STEP" ||
				step.iterator !== innerInitialize.iteratorDst ||
				step.next !== innerInitialize.nextDst
			);
		}) ||
		region.innerCloseIps.some((ip) => {
			const close = fn.instructions[ip];
			return (
				close?.opcode !== "ITERATOR_CLOSE" ||
				close.iterator !== innerInitialize.iteratorDst
			);
		}) ||
		region.cost.score !== 32 ||
		region.cost.metadataOperations !== payload.length ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip))
	) {
		throw new RangeError("program-image-codec: invalid iterator entry-pair region");
	}
}

function validateRegExpExecProjectionRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "regexp-exec-projection" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
): void {
	regexpExecProjectionGuardMasks(region.license);
	const property = fn.instructions[region.propertyIp];
	const call = fn.instructions[region.callIp];
	const callPlan = nativeCallPlanAt(nativeInstructions, region.callIp);
	const aliases = new Set(region.resultRegisters);
	let valid =
		region.representation === "regexp-capture-spans" &&
		region.lastIndexEffect === "retained-call-twin" &&
		region.anchors.length === 2 &&
		region.anchors[0] === region.callIp &&
		region.anchors[1] === region.loads[0]?.ip &&
		(call?.opcode === "CALL" || call?.opcode === "CALL_KNOWN") &&
		call.arguments.length === 1 &&
		(call.opcode === "CALL_KNOWN"
			? call.operation === "RegExp.prototype.exec" &&
				!call.construct &&
				call.argumentMode === undefined &&
				region.propertyIp === -1
			: property?.opcode === "LOAD_PROPERTY_STATIC" &&
				String.fromCharCode(...(stringConstants[property.stringIndex] ?? [])) ===
					"exec" &&
				callPlan?.guardedBuiltinCall?.operation === "RegExp.prototype.exec" &&
				property.dst === call.callee &&
				property.object === call.thisValue) &&
		// Encoding invariant, not a placement decision: reverse-postorder layout emits a
		// producer's block before its consumer's, so an in-place load precedes its call.
		// Whether the load runs there at all is `propertyPlacement`, checked next.
		region.propertyIp < region.callIp &&
		propertyPlacementHolds(
			fn,
			region.propertyPlacement,
			region.propertyIp,
			region.callIp,
		) &&
		(region.propertyPlacement !== "call-fallback" || region.lockedFreshLiteral) &&
		region.callee === (call.opcode === "CALL" ? call.callee : -1) &&
		region.receiver === call.thisValue &&
		region.input === call.arguments[0] &&
		region.result === call.dst &&
		aliases.has(call.dst) &&
		region.resultRegisters.length > 0 &&
		region.resultRegisters.length <= MAX_REGION_CLAIMS &&
		new Set(region.resultRegisters).size === region.resultRegisters.length &&
		region.resultRegisters.every(
			(register) =>
				Number.isInteger(register) && register >= 0 && register < fn.registerCount,
		) &&
		region.loads.length > 0 &&
		region.loads.length <= 8;
	for (const check of region.nullChecks) {
		const comparison = fn.instructions[check.comparisonIp];
		const nullValue = fn.instructions[check.nullIp];
		if (
			comparison?.opcode !== "BINARY" ||
			(comparison.operator !== "===" && comparison.operator !== "!==") ||
			nullValue?.opcode !== "CREATE_NULL" ||
			(!aliases.has(comparison.left) && !aliases.has(comparison.right)) ||
			(comparison.left !== nullValue.dst && comparison.right !== nullValue.dst)
		) {
			valid = false;
		}
	}
	if (region.lockedFreshLiteral !== (region.lockedLiteral !== undefined)) valid = false;
	if (region.lockedLiteral !== undefined) {
		const intrinsic = fn.instructions[region.lockedLiteral.constructorIntrinsicIp];
		const construct = fn.instructions[region.lockedLiteral.constructIp];
		if (
			!region.license.guard.dependencies.every(
				(dependency) => dependency.kind === "world",
			) ||
			!(
				(intrinsic?.opcode === "LOAD_INTRINSIC" && intrinsic.intrinsic === "RegExp") ||
				(intrinsic?.opcode === "LOAD_PRIMORDIAL" &&
					getPrimordialCatalog().nodes[intrinsic.nodeIndex]?.[0] === "RegExp")
			) ||
			!(construct?.opcode === "CONSTRUCT"
				? construct.callee === intrinsic.dst
				: construct?.opcode === "CALL_KNOWN" &&
					construct.operation === "RegExp" &&
					construct.construct === true &&
					construct.argumentMode === undefined &&
					construct.thisValue === intrinsic.dst) ||
			(construct?.opcode !== "CONSTRUCT" && construct?.opcode !== "CALL_KNOWN") ||
			construct.dst !== region.receiver
		) {
			valid = false;
		}
	}
	const payload = new Set<number>(
		[region.propertyIp, region.callIp].filter((ip) => ip >= 0),
	);
	for (const check of region.nullChecks) {
		payload.add(check.comparisonIp);
		payload.add(check.nullIp);
	}
	if (region.lockedLiteral !== undefined) {
		payload.add(region.lockedLiteral.constructorIntrinsicIp);
		payload.add(region.lockedLiteral.constructIp);
	}
	const indices = new Set<number>();
	const expectedProjectedStringMethodIdentity = vmGuardIsWorldInvariant(
		region.license.guard,
	)
		? "authority-invariant"
		: "runtime-guarded";
	const staticPropertyMatches = (
		instruction: BytecodeInstruction | undefined,
		object: number,
		name: string,
	): instruction is Extract<BytecodeInstruction, { opcode: "LOAD_PROPERTY_STATIC" }> =>
		instruction?.opcode === "LOAD_PROPERTY_STATIC" &&
		instruction.object === object &&
		String.fromCharCode(...(stringConstants[instruction.stringIndex] ?? [])) === name;
	for (const load of region.loads) {
		const capture = fn.instructions[load.ip];
		const key = fn.instructions[load.keyIp];
		payload.add(load.ip);
		payload.add(load.keyIp);
		if (
			capture?.opcode !== "LOAD_PROPERTY" ||
			!aliases.has(capture.object) ||
			capture.dst !== load.dst ||
			key?.opcode !== "CREATE_NUMBER" ||
			key.dst !== capture.key ||
			key.value !== load.captureIndex ||
			!Number.isInteger(load.captureIndex) ||
			load.captureIndex <= 0 ||
			load.captureIndex > 0xffff ||
			indices.has(load.captureIndex)
		) {
			valid = false;
		}
		indices.add(load.captureIndex);
		const consumer = load.consumer;
		if (consumer?.kind === "length") {
			payload.add(consumer.propertyIp);
			const length = fn.instructions[consumer.propertyIp];
			valid &&= staticPropertyMatches(length, load.dst, "length");
		} else if (consumer?.kind === "charCodeAtZero") {
			payload.add(consumer.propertyIp);
			payload.add(consumer.callIp);
			if (consumer.zeroIp !== undefined) payload.add(consumer.zeroIp);
			const propertyInstruction = fn.instructions[consumer.propertyIp];
			const callInstruction = fn.instructions[consumer.callIp];
			const argument =
				callInstruction?.opcode === "CALL" && callInstruction.arguments[0] !== undefined
					? decodeVmValueOperand(callInstruction.arguments[0])
					: undefined;
			const zero =
				consumer.zeroIp === undefined ? undefined : fn.instructions[consumer.zeroIp];
			const zeroArgument =
				argument?.kind === "number" && Object.is(argument.value, 0)
					? true
					: argument?.kind === "register" &&
						zero?.opcode === "CREATE_NUMBER" &&
						Object.is(zero.value, 0) &&
						argument.register === zero.dst;
			valid &&=
				consumer.methodIdentity === expectedProjectedStringMethodIdentity &&
				staticPropertyMatches(propertyInstruction, load.dst, "charCodeAt") &&
				callInstruction?.opcode === "CALL" &&
				callInstruction.callee === propertyInstruction.dst &&
				callInstruction.thisValue === load.dst &&
				callInstruction.arguments.length === 1 &&
				zeroArgument;
		} else if (consumer?.kind === "number") {
			if (consumer.intrinsicIp >= 0) payload.add(consumer.intrinsicIp);
			payload.add(consumer.callIp);
			const intrinsic = fn.instructions[consumer.intrinsicIp];
			const numberCall = fn.instructions[consumer.callIp];
			const argument =
				(numberCall?.opcode === "CALL" || numberCall?.opcode === "CALL_KNOWN") &&
				numberCall.arguments[0] !== undefined
					? decodeVmValueOperand(numberCall.arguments[0])
					: undefined;
			valid &&=
				(numberCall?.opcode === "CALL" || numberCall?.opcode === "CALL_KNOWN") &&
				(numberCall.opcode === "CALL_KNOWN"
					? numberCall.operation === "Number" &&
						!numberCall.construct &&
						numberCall.argumentMode === undefined &&
						consumer.intrinsicIp === -1
					: intrinsic?.opcode === "LOAD_INTRINSIC" &&
						intrinsic.intrinsic === "Number" &&
						numberCall.callee === intrinsic.dst) &&
				numberCall.arguments.length === 1 &&
				argument?.kind === "register" &&
				argument.register === load.dst;
		} else if (consumer?.kind === "asciiCaseLength") {
			for (const ip of [
				consumer.upperPropertyIp,
				consumer.upperCallIp,
				consumer.lowerPropertyIp,
				consumer.lowerCallIp,
				...consumer.resultMoveIps,
				consumer.lengthPropertyIp,
			]) {
				payload.add(ip);
			}
			const upperProperty = fn.instructions[consumer.upperPropertyIp];
			const upperCall = fn.instructions[consumer.upperCallIp];
			const lowerProperty = fn.instructions[consumer.lowerPropertyIp];
			const lowerCall = fn.instructions[consumer.lowerCallIp];
			let lowerResult = lowerCall?.opcode === "CALL" ? lowerCall.dst : -1;
			let movesValid = lowerResult >= 0;
			for (const ip of consumer.resultMoveIps) {
				const move = fn.instructions[ip];
				if (move?.opcode !== "MOVE" || move.src !== lowerResult) {
					movesValid = false;
					break;
				}
				lowerResult = move.dst;
			}
			const lengthProperty = fn.instructions[consumer.lengthPropertyIp];
			valid &&=
				consumer.methodIdentity === expectedProjectedStringMethodIdentity &&
				staticPropertyMatches(upperProperty, load.dst, "toUpperCase") &&
				upperCall?.opcode === "CALL" &&
				upperCall.callee === upperProperty.dst &&
				upperCall.thisValue === load.dst &&
				upperCall.arguments.length === 0 &&
				staticPropertyMatches(lowerProperty, upperCall.dst, "toLowerCase") &&
				lowerCall?.opcode === "CALL" &&
				lowerCall.callee === lowerProperty.dst &&
				lowerCall.thisValue === upperCall.dst &&
				lowerCall.arguments.length === 0 &&
				movesValid &&
				staticPropertyMatches(lengthProperty, lowerResult, "length");
		}
	}
	if (
		!valid ||
		region.cost.metadataOperations !== payload.size ||
		payload.size !== region.claimedIps.length ||
		region.claimedIps.some((ip) => !payload.has(ip))
	) {
		throw new RangeError("program-image-codec: invalid RegExp.exec projection region");
	}
}

function validateRegExpIteratorProjectionRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "regexp-iterator-projection" }>,
): void {
	regexpIteratorProjectionGuardMasks(region.license);
	const step = fn.instructions[region.stepIp];
	const doneBranch = fn.instructions[region.doneBranchIp];
	const aliases = new Set(region.resultRegisters);
	let valid =
		region.representation === "regexp-iterator-capture-spans" &&
		region.statefulEffect === "iterator-last-index-retained-step" &&
		region.runtimeGuard === "exact-brand-next-realm-regexp" &&
		region.anchors.length === 3 &&
		region.anchors[0] === region.stepIp &&
		region.anchors[1] === region.doneBranchIp &&
		region.anchors[2] === region.loads[0]?.ip &&
		step?.opcode === "ITERATOR_STEP" &&
		doneBranch?.opcode === "JUMP_IF" &&
		// Encoding only: Core certifies the step as the last instruction of its block and
		// the branch as that block's terminator, so the pair is emitted back to back.
		region.doneBranchIp === region.stepIp + 1 &&
		doneBranch.cond === step.doneDst &&
		doneBranch.targetIp === region.exitIp &&
		region.iterator === step.iterator &&
		region.next === step.next &&
		region.value === step.valueDst &&
		region.done === step.doneDst &&
		aliases.has(step.valueDst) &&
		region.resultRegisters.length > 0 &&
		region.resultRegisters.length <= MAX_REGION_CLAIMS &&
		new Set(region.resultRegisters).size === region.resultRegisters.length &&
		region.resultRegisters.every(
			(register) =>
				Number.isInteger(register) && register >= 0 && register < fn.registerCount,
		) &&
		region.loads.length > 0 &&
		region.loads.length <= 8 &&
		region.controlFlow.exceptionalHandlerIps.length > 0;
	const payload = new Set<number>([region.stepIp, region.doneBranchIp]);
	const indices = new Set<number>();
	for (const load of region.loads) {
		const capture = fn.instructions[load.ip];
		const key = fn.instructions[load.keyIp];
		const intrinsic = fn.instructions[load.numberIntrinsicIp];
		const call = fn.instructions[load.numberCallIp];
		const argument =
			(call?.opcode === "CALL" || call?.opcode === "CALL_KNOWN") &&
			call.arguments[0] !== undefined
				? decodeVmValueOperand(call.arguments[0])
				: undefined;
		if (
			capture?.opcode !== "LOAD_PROPERTY" ||
			!aliases.has(capture.object) ||
			capture.dst !== load.dst ||
			key?.opcode !== "CREATE_NUMBER" ||
			key.dst !== capture.key ||
			key.value !== load.captureIndex ||
			!Number.isInteger(load.captureIndex) ||
			load.captureIndex <= 0 ||
			load.captureIndex > 0xffff ||
			indices.has(load.captureIndex) ||
			(call?.opcode !== "CALL" && call?.opcode !== "CALL_KNOWN") ||
			(call.opcode === "CALL_KNOWN"
				? call.operation !== "Number" ||
					call.construct ||
					call.argumentMode !== undefined ||
					load.numberIntrinsicIp !== -1
				: intrinsic?.opcode !== "LOAD_INTRINSIC" ||
					intrinsic.intrinsic !== "Number" ||
					call.callee !== intrinsic.dst) ||
			call.arguments.length !== 1 ||
			argument?.kind !== "register" ||
			argument.register !== load.dst
		) {
			valid = false;
		}
		indices.add(load.captureIndex);
		payload.add(load.ip);
		payload.add(load.keyIp);
		if (load.numberIntrinsicIp >= 0) payload.add(load.numberIntrinsicIp);
		payload.add(load.numberCallIp);
	}
	const activeHandlers = new Set<number>();
	for (const ip of region.claimedIps) {
		for (const handler of fn.handlers) {
			if (ip >= handler.startIp && ip < handler.endIp) {
				activeHandlers.add(handler.handlerIp);
			}
		}
	}
	if (
		!valid ||
		activeHandlers.size !== region.controlFlow.exceptionalHandlerIps.length ||
		region.controlFlow.exceptionalHandlerIps.some((ip) => !activeHandlers.has(ip)) ||
		region.cost.metadataOperations !== payload.size ||
		payload.size !== region.claimedIps.length ||
		region.claimedIps.some((ip) => !payload.has(ip))
	) {
		throw new RangeError(
			"program-image-codec: invalid RegExp iterator projection region",
		);
	}
}

function validateStringSplitProjectionRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "string-split-projection" }>,
	stringConstants: ReadonlyArray<ReadonlyArray<number>>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
): void {
	const { dependencyMask } = stringSplitProjectionGuardMasks(region.license);
	const stringConstantEquals = (index: number, value: string): boolean => {
		const constant = stringConstants[index];
		return (
			constant?.length === value.length &&
			constant.every((codeUnit, offset) => codeUnit === value.charCodeAt(offset))
		);
	};
	const callIp = region.anchors[0]!;
	const firstLoadIp = region.anchors[1]!;
	const call = fn.instructions[callIp];
	const callPlan = nativeCallPlanAt(nativeInstructions, callIp);
	const property = region.propertyIp < 0 ? undefined : fn.instructions[region.propertyIp];
	const separatorProducer = fn.instructions[region.separatorIp];
	const registerValid = (register: number) =>
		Number.isInteger(register) && register >= 0 && register < fn.registerCount;
	const callMatches =
		call?.opcode === "CALL"
			? (dependencyMask === 1 || dependencyMask === 4) &&
				region.propertyIp >= 0 &&
				property?.opcode === "LOAD_PROPERTY_STATIC" &&
				property.dst === region.callee &&
				property.object === region.receiver &&
				stringConstantEquals(property.stringIndex, "split") &&
				call.callee === region.callee &&
				call.thisValue === region.receiver &&
				callPlan?.guardedBuiltinCall?.operation === "String.prototype.split" &&
				callPlan.guardedBuiltinCall.guard.dependencies.length === 1 &&
				(dependencyMask === 1
					? callPlan.guardedBuiltinCall.guard.dependencies[0]?.kind === "world"
					: callPlan.guardedBuiltinCall.guard.dependencies[0]?.kind === "epoch" &&
						callPlan.guardedBuiltinCall.guard.dependencies[0]?.family ===
							"watched-methods") &&
				callPlan.guardedBuiltinCall.guard.obligations.length === 1 &&
				callPlan.guardedBuiltinCall.guard.obligations[0] === "fallback"
			: call?.opcode === "CALL_KNOWN" &&
				dependencyMask === 1 &&
				region.propertyIp === -1 &&
				region.callee === -1 &&
				call.operation === "String.prototype.split" &&
				call.thisValue === region.receiver;
	const expectedSplitIdentity =
		call?.opcode === "CALL_KNOWN" ||
		(call?.opcode === "CALL" &&
			callPlan?.guardedBuiltinCall !== undefined &&
			vmGuardIsWorldInvariant(callPlan.guardedBuiltinCall.guard))
			? "authority-invariant"
			: "runtime-guarded";
	const separator =
		(call?.opcode === "CALL" || call?.opcode === "CALL_KNOWN") &&
		call.arguments.length === 1
			? decodeVmValueOperand(call.arguments[0]!)
			: undefined;
	const separatorMatches =
		separator?.kind === "string"
			? separator.index === region.separatorStringIndex
			: separator?.kind === "register" &&
				separatorProducer?.opcode === "CREATE_STRING" &&
				separatorProducer.dst === separator.register &&
				separatorProducer.stringIndex === region.separatorStringIndex;
	const resultRegisters = new Set(region.resultRegisters);
	let operationsValid = true;
	for (const load of region.loads) {
		const instruction = fn.instructions[load.ip];
		if (
			(instruction?.opcode !== "LOAD_PROPERTY" &&
				instruction?.opcode !== "LOAD_PROPERTY_STATIC") ||
			!resultRegisters.has(instruction.object) ||
			instruction.dst !== load.dst
		) {
			operationsValid = false;
			break;
		}
		if (load.kind === "length") {
			if (
				instruction.opcode !== "LOAD_PROPERTY_STATIC" ||
				!stringConstantEquals(instruction.stringIndex, "length")
			) {
				operationsValid = false;
				break;
			}
		} else {
			const key = fn.instructions[load.keyIp];
			if (
				instruction.opcode !== "LOAD_PROPERTY" ||
				!Number.isInteger(load.index) ||
				load.index < 0 ||
				load.index > 0xffff ||
				key?.opcode !== "CREATE_NUMBER" ||
				key.dst !== instruction.key ||
				key.value !== load.index
			) {
				operationsValid = false;
				break;
			}
		}
	}
	const elementLoads = region.loads.filter((load) => load.kind === "element");
	const lengthLoads = region.loads.filter((load) => load.kind === "length");
	const operationIps = [
		...(region.propertyIp < 0 ? [] : [region.propertyIp]),
		region.separatorIp,
		region.callIp,
		...region.loads.flatMap((load) =>
			load.kind === "element" ? [load.keyIp, load.ip] : [load.ip],
		),
	];
	if (
		region.representation !== "projected-elements" ||
		region.license.materialization !== "whole-region" ||
		region.anchors.length !== 2 ||
		region.callIp !== callIp ||
		firstLoadIp !== region.loads[0]?.ip ||
		!callMatches ||
		(call?.opcode !== "CALL" && call?.opcode !== "CALL_KNOWN") ||
		call.arguments.length !== 1 ||
		!registerValid(region.receiver) ||
		region.resultRegisters.length === 0 ||
		region.resultRegisters.length > MAX_REGION_CLAIMS ||
		resultRegisters.size !== region.resultRegisters.length ||
		region.resultRegisters.some((register) => !registerValid(register)) ||
		!resultRegisters.has(call.dst) ||
		region.separatorStringIndex < 0 ||
		region.separatorStringIndex >= stringConstants.length ||
		stringConstants[region.separatorStringIndex]?.length === 0 ||
		!separatorMatches ||
		region.splitIdentity !== expectedSplitIdentity ||
		!propertyPlacementHolds(fn, region.propertyPlacement, region.propertyIp, callIp) ||
		(region.propertyPlacement === "call-fallback" &&
			region.splitIdentity !== "authority-invariant") ||
		elementLoads.length === 0 ||
		elementLoads.length > 8 ||
		lengthLoads.length > 1 ||
		new Set(elementLoads.map((load) => load.index)).size !== elementLoads.length ||
		new Set(region.loads.map((load) => load.ip)).size !== region.loads.length ||
		region.loads.some(
			(load, index) =>
				load.ip <= callIp || (index > 0 && region.loads[index - 1]!.ip >= load.ip),
		) ||
		!operationsValid ||
		region.cost.metadataOperations !== operationIps.length ||
		new Set(operationIps).size !== operationIps.length ||
		operationIps.length !== region.claimedIps.length ||
		operationIps.some((ip) => !region.claimedIps.includes(ip))
	) {
		throw new RangeError(
			"program-image-codec: invalid String.split projection region metadata",
		);
	}
}

function validateStringSplitCursorRegion(
	fn: BytecodeFunction,
	region: Extract<VmRegion, { kind: "string-split-cursor" }>,
	nativeInstructions: ReadonlyArray<NativeInstructionPlan | undefined>,
): void {
	stringSplitCursorGuardMasks(region.license);
	const callIp = region.anchors[0]!;
	const headerBranchIp = region.anchors[1]!;
	const lengthIp = region.anchors[2]!;
	const backedgeIp = region.anchors[3]!;
	const call = fn.instructions[callIp];
	const callPlan = nativeCallPlanAt(nativeInstructions, callIp);
	const headerBranch = fn.instructions[headerBranchIp];
	const property = region.propertyIp < 0 ? undefined : fn.instructions[region.propertyIp];
	const length = fn.instructions[lengthIp];
	// Encoding only: Core's cursor certificate fixes the header and latch shape, so
	// the wire form names the length load, header branch, and backedge and derives the
	// compare, exit jump, and increment from their fixed offsets. A shape that does not
	// match rejects the image; nothing here decides whether the region applies.
	const compare = fn.instructions[lengthIp + 1];
	const exitJump = fn.instructions[headerBranchIp + 1];
	const element = fn.instructions[region.elementIp];
	const trimProperty = fn.instructions[region.trimPropertyIp];
	const trimCall = fn.instructions[region.trimCallIp];
	const trimCallPlan = nativeCallPlanAt(nativeInstructions, region.trimCallIp);
	const increment = fn.instructions[backedgeIp - 1];
	const possibleAdvance = fn.instructions[backedgeIp - 2];
	const advance =
		possibleAdvance?.opcode === "UNARY" && possibleAdvance.operator === "tonumeric"
			? possibleAdvance
			: undefined;
	const advanceIp =
		advance !== undefined &&
		advance.src === region.index &&
		increment?.opcode === "UNARY" &&
		increment.src === advance.dst
			? backedgeIp - 2
			: undefined;
	const backedge = fn.instructions[backedgeIp];
	const backedgeReachesHeader = (() => {
		if (backedge?.opcode !== "JUMP") return false;
		const visited = new Set<number>();
		let ip = backedge.targetIp;
		while (ip !== lengthIp) {
			if (visited.has(ip)) return false;
			visited.add(ip);
			const instruction = fn.instructions[ip];
			if (instruction?.opcode === "MOVE") {
				ip++;
				continue;
			}
			if (instruction?.opcode !== "JUMP") return false;
			ip = instruction.targetIp;
		}
		return true;
	})();
	const operationIps = [
		...(region.propertyIp < 0 ? [] : [region.propertyIp]),
		callIp,
		lengthIp,
		lengthIp + 1,
		headerBranchIp,
		region.elementIp,
		region.trimPropertyIp,
		region.trimCallIp,
		...region.primitiveStringLengthIps,
		...(advanceIp === undefined ? [] : [advanceIp]),
		backedgeIp - 1,
		backedgeIp,
	];
	const registerValid = (value: number) =>
		Number.isInteger(value) && value >= 0 && value < fn.registerCount;
	const resultRegisters = new Set(region.resultRegisters);
	const callMatches =
		call?.opcode === "CALL"
			? region.propertyIp >= 0 &&
				property?.opcode === "LOAD_PROPERTY_STATIC" &&
				property.dst === region.callee &&
				property.object === region.receiver &&
				call.callee === region.callee &&
				callPlan?.guardedBuiltinCall?.operation === "String.prototype.split"
			: call?.opcode === "CALL_KNOWN" &&
				region.propertyIp === -1 &&
				region.callee === -1 &&
				call.operation === "String.prototype.split";
	const expectedSplitIdentity =
		call?.opcode === "CALL_KNOWN" ||
		(call?.opcode === "CALL" &&
			callPlan?.guardedBuiltinCall !== undefined &&
			vmGuardIsWorldInvariant(callPlan.guardedBuiltinCall.guard))
			? "authority-invariant"
			: "runtime-guarded";
	const expectedTrimIdentity =
		trimCall?.opcode === "CALL" &&
		trimCallPlan?.guardedBuiltinCall !== undefined &&
		vmGuardIsWorldInvariant(trimCallPlan.guardedBuiltinCall.guard)
			? "authority-invariant"
			: "runtime-guarded";
	const primitiveLengthIps = new Set(region.primitiveStringLengthIps);
	let primitiveLengthsValid =
		primitiveLengthIps.size === region.primitiveStringLengthIps.length;
	const trimAliases = new Set<number>(trimCall?.opcode === "CALL" ? [trimCall.dst] : []);
	for (let ip = region.trimCallIp + 1; primitiveLengthsValid && ip <= backedgeIp; ip++) {
		const instruction = fn.instructions[ip];
		if (instruction === undefined) {
			primitiveLengthsValid = false;
			break;
		}
		if (primitiveLengthIps.has(ip)) {
			primitiveLengthsValid =
				instruction.opcode === "LOAD_PROPERTY_STATIC" &&
				nativeInstructions[ip]?.kind === "primitive-string-length" &&
				trimAliases.has(instruction.object);
		}
		const moveAlias = instruction.opcode === "MOVE" && trimAliases.has(instruction.src);
		if ("dst" in instruction && trimAliases.has(instruction.dst)) {
			trimAliases.delete(instruction.dst);
		}
		if (moveAlias && instruction.opcode === "MOVE") trimAliases.add(instruction.dst);
	}
	if (
		region.representation !== "split-cursor-spans" ||
		region.license.materialization !== "on-demand" ||
		region.anchors.length !== 4 ||
		!callMatches ||
		region.splitIdentity !== expectedSplitIdentity ||
		region.trimIdentity !== expectedTrimIdentity ||
		call === undefined ||
		(call.opcode !== "CALL" && call.opcode !== "CALL_KNOWN") ||
		call.thisValue !== region.receiver ||
		call.argumentCount !== 1 ||
		call.arguments[0] !== region.separator ||
		region.resultRegisters.length === 0 ||
		region.resultRegisters.length > MAX_REGION_CLAIMS ||
		resultRegisters.size !== region.resultRegisters.length ||
		region.resultRegisters.some((register) => !registerValid(register)) ||
		!resultRegisters.has(call.dst) ||
		!registerValid(region.index) ||
		length?.opcode !== "LOAD_PROPERTY_STATIC" ||
		!resultRegisters.has(length.object) ||
		compare?.opcode !== "BINARY" ||
		compare.operator !== "<" ||
		compare.right !== length.dst ||
		compare.left !== region.index ||
		headerBranchIp !== lengthIp + 2 ||
		headerBranch?.opcode !== "JUMP_IF" ||
		headerBranch.cond !== compare.dst ||
		headerBranch.targetIp !== region.elementIp ||
		exitJump?.opcode !== "JUMP" ||
		exitJump.targetIp !== region.exitIp ||
		element?.opcode !== "LOAD_PROPERTY" ||
		!resultRegisters.has(element.object) ||
		element.key !== region.index ||
		region.trimPropertyIp !== region.elementIp + 1 ||
		trimProperty?.opcode !== "LOAD_PROPERTY_STATIC" ||
		trimProperty.object !== element.dst ||
		trimProperty.icIndex !== region.trimIcIndex ||
		region.trimCallIp !== region.trimPropertyIp + 1 ||
		trimCall?.opcode !== "CALL" ||
		trimCall.callee !== trimProperty.dst ||
		trimCall.thisValue !== element.dst ||
		trimCall.argumentCount !== 0 ||
		trimCallPlan?.guardedBuiltinCall?.operation !== "String.prototype.trim" ||
		increment?.opcode !== "UNARY" ||
		increment.operator !== "increment" ||
		increment.src !== (advanceIp === undefined ? region.index : advance!.dst) ||
		increment.dst !== region.index ||
		!backedgeReachesHeader ||
		backedgeIp <= region.trimCallIp ||
		region.exitIp < 0 ||
		region.exitIp > fn.instructions.length ||
		region.primitiveStringLengthIps.length > MAX_STRING_SPLIT_CURSOR_LENGTH_LOADS ||
		!primitiveLengthsValid ||
		!propertyPlacementHolds(fn, region.propertyPlacement, region.propertyIp, callIp) ||
		(region.propertyPlacement === "call-fallback" &&
			region.splitIdentity !== "authority-invariant") ||
		new Set(operationIps).size !== operationIps.length ||
		operationIps.length !== region.claimedIps.length ||
		operationIps.some(
			(ip) => ip < 0 || ip >= fn.instructions.length || !region.claimedIps.includes(ip),
		) ||
		region.cost.metadataOperations !== operationIps.length
	) {
		throw new RangeError(
			"program-image-codec: invalid String.split cursor region metadata",
		);
	}
}

export function deserializeCompilerArtifact(bytes: Uint8Array): ProgramImage {
	const { reader, runtime } = readRuntimeImage(
		bytes,
		COMPILER_ARTIFACT_MAGIC,
		COMPILER_ARTIFACT_VERSION,
	);
	return readCompilerArtifact(reader, runtime);
}

function readCompilerArtifact(r: Reader, runtimeImage: RuntimeImage): ProgramImage {
	const { functions, stringConstants } = runtimeImage;
	const semanticProtectorCount = r.count(3);
	if (semanticProtectorCount > 3) {
		throw new RangeError("program-image-codec: too many semantic protector facts");
	}
	const semanticProtectors: Array<VmSemanticProtectorFact> = [];
	const seenSemanticProtectors = new Set<VmSemanticProtectorFact["family"]>();
	for (let index = 0; index < semanticProtectorCount; index++) {
		const tag = r.u8();
		const family =
			tag === 1
				? "primitive-methods"
				: tag === 2
					? "watched-methods"
					: tag === 3
						? "array-elements"
						: undefined;
		const dependencyMask = r.u8();
		const obligationMask = r.u8();
		if (
			family === undefined ||
			seenSemanticProtectors.has(family) ||
			(dependencyMask !== 1 && dependencyMask !== 1 << tag) ||
			obligationMask !== 1
		) {
			throw new RangeError("program-image-codec: invalid semantic protector fact");
		}
		seenSemanticProtectors.add(family);
		semanticProtectors.push({
			family,
			guard: {
				dependencies: [
					dependencyMask === 1
						? { kind: "world", fact: "primordials.locked" }
						: { kind: "epoch", family },
				],
				obligations: ["fallback"],
			},
		});
	}

	const compilerMetadataFunctionCount = r.count(1);
	if (compilerMetadataFunctionCount !== functions.length) {
		throw new Error("program-image-codec: compiler metadata function count mismatch");
	}
	const nativeFunctions: Array<NativeFunctionPlan> = [];
	for (const [functionIndex, fn] of functions.entries()) {
		const safepointCount = r.count(2);
		const safepoints: Array<NativeFunctionPlan["gc"]["safepoints"][number]> = [];
		for (let safepointIndex = 0; safepointIndex < safepointCount; safepointIndex++) {
			const kindTag = r.u8();
			const instructionIp = r.i32();
			const rootRegisters = r.i32Array();
			if (
				kindTag > 2 ||
				instructionIp < 0 ||
				instructionIp >= fn.instructions.length ||
				rootRegisters.some((register) => register < 0 || register >= fn.registerCount)
			) {
				throw new RangeError("program-image-codec: invalid native safepoint metadata");
			}
			safepoints.push({
				kind:
					kindTag === 0 ? "operation" : kindTag === 1 ? "loop-backedge" : "conservative",
				instructionIp,
				rootRegisters,
			});
		}

		const representationCount = r.count(1);
		if (representationCount !== fn.registerCount) {
			throw new Error("program-image-codec: register representation count mismatch");
		}
		const registerRepresentations = Array.from(
			{ length: representationCount },
			(_, register) => {
				const tag = r.u8();
				if (tag === 0) return "boxed" as const;
				if (register < fn.parameterCount) {
					throw new Error("program-image-codec: non-boxed parameter representation");
				}
				if (tag === 1) return "number" as const;
				if (tag === 2) return "boolean" as const;
				if (tag === 3) return "int32" as const;
				if (tag === 4) return "string" as const;
				throw new Error("program-image-codec: invalid register representation tag");
			},
		);
		const literalSwitchCount = r.count(6);
		const literalSwitches = Array.from({ length: literalSwitchCount }, () => {
			const kind = r.u8();
			if (kind !== 0 && kind !== 1)
				throw new RangeError("Invalid native literal switch kind");
			const site = {
				instructionIp: r.u32(),
				endIp: r.u32(),
				selector: r.u32(),
				defaultIp: r.u32(),
			};
			return kind === 0
				? {
						...site,
						kind: "number" as const,
						cases: Array.from({ length: r.count(2) }, () => ({
							value: r.i32(),
							targetIp: r.u32(),
						})),
					}
				: {
						...site,
						kind: "string" as const,
						cases: Array.from({ length: r.count(2) }, () => ({
							stringIndex: r.u32(),
							targetIp: r.u32(),
						})),
					};
		});
		const fieldCallCount = r.count(12);
		const fieldCalls = Array.from({ length: fieldCallCount }, () => ({
			allocationIp: r.u32(),
			callIp: r.u32(),
			entries: Array.from({ length: r.count(8) }, () => ({
				functionIndex: r.u32(),
				entryId: r.u32(),
			})),
		}));
		const specializedOnly = r.u8();
		if (specializedOnly > 1) throw new RangeError("invalid native body reachability");
		const directEntryCount = r.count(1);
		if (directEntryCount > 4) {
			throw new RangeError("program-image-codec: too many native direct entries");
		}
		const directEntries: Array<NativeFunctionPlan["directEntries"][number]> = [];
		const readRepresentation = ():
			| "boxed"
			| "int32"
			| "number"
			| "boolean"
			| "string" => {
			const tag = r.u8();
			if (tag === 0) return "boxed";
			if (tag === 1) return "number";
			if (tag === 2) return "boolean";
			if (tag === 3) return "int32";
			if (tag === 4) return "string";
			throw new Error("program-image-codec: invalid direct-entry representation tag");
		};
		for (let entryIndex = 0; entryIndex < directEntryCount; entryIndex++) {
			const id = r.u32();
			const resultRepresentation = readRepresentation();
			const parameterCount = r.count(1);
			if (id !== entryIndex || parameterCount !== fn.parameterCount) {
				throw new Error("program-image-codec: invalid direct-entry signature");
			}
			const parameterRepresentations = Array.from(
				{ length: parameterCount },
				readRepresentation,
			);
			const argumentCount = r.i32();
			if (argumentCount < -1 || argumentCount > 16)
				throw new Error("program-image-codec: invalid direct-entry arity");
			const argumentRepresentations =
				argumentCount < 0
					? undefined
					: Array.from({ length: argumentCount }, readRepresentation);
			const fieldKeyCount = r.count(4);
			if (fieldKeyCount > 4) throw new Error("program-image-codec: invalid field count");
			const fieldKeys = Array.from({ length: fieldKeyCount }, () => r.u32());
			const fieldLoads = Array.from({ length: r.count(8) }, () => ({
				instructionIp: r.u32(),
				field: r.u32(),
			}));
			if (fieldKeyCount === 0 && fieldLoads.length > 0)
				throw new Error("program-image-codec: field loads lack keys");
			const fieldParameters =
				fieldKeyCount === 0 ? undefined : { keys: fieldKeys, loads: fieldLoads };
			const constantCount = r.count(5);
			const constantBooleans = Array.from({ length: constantCount }, () => {
				const instructionIp = r.i32();
				const value = r.u8();
				if (fn.instructions[instructionIp]?.opcode !== "BINARY" || value > 1)
					throw new Error("program-image-codec: invalid direct-entry comparison");
				return { instructionIp, value: value === 1 };
			});
			const operatorInputs = Array.from({ length: r.count(6) }, () => {
				const instructionIp = r.u32();
				const count = r.u8();
				if (count !== 1 && count !== 2)
					throw new RangeError("Invalid native operator arity");
				const masks = Array.from({ length: count }, () =>
					r.u8(),
				) as unknown as CompilerOperatorInputKindMasks;
				return { instructionIp, masks };
			});
			const directRegisterCount = r.count(1);
			if (directRegisterCount !== fn.registerCount) {
				throw new Error("program-image-codec: direct-entry register count mismatch");
			}
			const directRegisterRepresentations = Array.from(
				{ length: directRegisterCount },
				readRepresentation,
			);
			if (
				parameterRepresentations.some(
					(representation, register) =>
						directRegisterRepresentations[register] !== representation,
				)
			) {
				throw new Error("program-image-codec: invalid direct-entry register classes");
			}
			const directSafepointCount = r.count(2);
			const directSafepoints: Array<NativeFunctionPlan["gc"]["safepoints"][number]> = [];
			for (
				let safepointIndex = 0;
				safepointIndex < directSafepointCount;
				safepointIndex++
			) {
				const kindTag = r.u8();
				const instructionIp = r.i32();
				const rootRegisters = r.i32Array();
				if (
					kindTag > 1 ||
					instructionIp < 0 ||
					instructionIp >= fn.instructions.length ||
					rootRegisters.some((register) => register < 0 || register >= fn.registerCount)
				) {
					throw new RangeError("program-image-codec: invalid direct-entry safepoint");
				}
				directSafepoints.push({
					kind: kindTag === 0 ? "operation" : "loop-backedge",
					instructionIp,
					rootRegisters,
				});
			}
			const entry = {
				id,
				parameterRepresentations,
				resultRepresentation,
				...(argumentRepresentations === undefined ? {} : { argumentRepresentations }),
				...(constantCount === 0 ? {} : { constantBooleans }),
				...(operatorInputs.length === 0 ? {} : { operatorInputs }),
				...(fieldParameters === undefined ? {} : { fieldParameters }),
				registerRepresentations: directRegisterRepresentations,
				gc: { safepoints: directSafepoints },
			};
			validateNativeDirectEntry(fn, entry);
			nativeFrameRootRegisters(fn, entry);
			directEntries.push(entry);
		}

		const nativeInstructions: Array<NativeInstructionPlan | undefined> = Array.from({
			length: fn.instructions.length,
		});
		const instructionMetadataCount = r.count(2);
		let previousInstructionMetadataIndex = -1;
		for (
			let metadataIndex = 0;
			metadataIndex < instructionMetadataCount;
			metadataIndex++
		) {
			const instructionIndex = r.u32();
			if (instructionIndex <= previousInstructionMetadataIndex) {
				throw new RangeError(
					"program-image-codec: unordered compiler instruction metadata",
				);
			}
			previousInstructionMetadataIndex = instructionIndex;
			const instruction = fn.instructions[instructionIndex];
			if (instruction === undefined) {
				throw new RangeError(
					"program-image-codec: compiler instruction metadata index out of range",
				);
			}
			const tag = r.u8();
			if (tag === 1 && instruction.opcode === "CALL") {
				const directFunctionIndex = r.i32();
				const guardedFunctionIndices = r.i32Array();
				const directCallTargetFunctionIndex = r.i32();
				const directCallbackFunctionIndex = r.i32();
				const directEntryId = r.i32();
				const numericCallbackTag = r.u8();
				if (numericCallbackTag > 4)
					throw new RangeError("Invalid numeric sort callback tag");
				const numericSortCallback =
					numericCallbackTag === 0
						? undefined
						: {
								operation:
									numericCallbackTag % 2 === 1
										? ("sort" as const)
										: ("toSorted" as const),
								...(numericCallbackTag > 2 ? { viaCall: true as const } : {}),
								functionIndex: r.i32(),
								entryId: r.i32(),
							};

				const flags = r.u8();
				const collectionTag = r.u8();
				const guardedBuiltinCount =
					((flags & 2) !== 0 ? 1 : 0) +
					((flags & 4) !== 0 ? 1 : 0) +
					(collectionTag !== 0 ? 1 : 0);
				if (
					directFunctionIndex < -1 ||
					directFunctionIndex >= functions.length ||
					guardedFunctionIndices.length > 4 ||
					(directFunctionIndex >= 0 && guardedFunctionIndices.length !== 0) ||
					guardedFunctionIndices.some(
						(target, index) =>
							target < 0 ||
							target >= functions.length ||
							(index > 0 && target <= guardedFunctionIndices[index - 1]!),
					) ||
					directCallTargetFunctionIndex < -1 ||
					directCallTargetFunctionIndex >= functions.length ||
					directCallbackFunctionIndex < -1 ||
					directCallbackFunctionIndex >= functions.length ||
					directEntryId < -1 ||
					(directEntryId >= 0 &&
						((directFunctionIndex < 0 && guardedFunctionIndices.length !== 1) ||
							directEntryId >= 4)) ||
					(flags & 24) !== 0 ||
					((flags & 32) !== 0 && (flags & 4) === 0) ||
					(directCallTargetFunctionIndex >= 0 && (flags & 1) === 0) ||
					collectionTag > TAGGED_GUARDED_BUILTIN_OPERATIONS.length ||
					guardedBuiltinCount > 1 ||
					((flags & 64) !== 0 && guardedBuiltinCount !== 1) ||
					((flags & 128) !== 0 &&
						(guardedBuiltinCount !== 1 ||
							guardedBuiltinCallBrandTag(collectionTag) === undefined)) ||
					(directFunctionIndex < 0 ? undefined : directFunctionIndex) !==
						instruction.exactFunctionIndex ||
					!sameOptionalFunctionTargets(
						guardedFunctionIndices,
						instruction.guardedFunctionIndices,
					)
				) {
					throw new RangeError("program-image-codec: invalid CALL compiler metadata");
				}
				let guardedBuiltinCall: VmGuardedBuiltinCall | undefined;
				if (guardedBuiltinCount === 1) {
					const operation =
						(flags & 2) !== 0
							? "Array.prototype.push"
							: (flags & 4) !== 0
								? "String.prototype.charCodeAt"
								: TAGGED_GUARDED_BUILTIN_OPERATIONS[collectionTag - 1]!;
					guardedBuiltinCall = {
						operation,
						guard: {
							dependencies: [
								(flags & 64) !== 0
									? { kind: "world", fact: "primordials.locked" }
									: { kind: "epoch", family: "watched-methods" },
							],
							obligations: ["fallback"],
						},
					};
				}
				if (
					directCallbackFunctionIndex >= 0 &&
					(guardedBuiltinCall === undefined ||
						!ARRAY_ITERATION_CALLBACK_OPERATIONS.has(guardedBuiltinCall.operation))
				) {
					throw new RangeError("program-image-codec: invalid exact callback metadata");
				}
				nativeInstructions[instructionIndex] = {
					kind: "call",
					...(directFunctionIndex < 0 ? {} : { directFunctionIndex }),
					...(guardedFunctionIndices.length === 0 ? {} : { guardedFunctionIndices }),
					...(directCallTargetFunctionIndex < 0 ? {} : { directCallTargetFunctionIndex }),
					...(directCallbackFunctionIndex < 0 ? {} : { directCallbackFunctionIndex }),
					...(directEntryId < 0 ? {} : { directEntryId }),
					...(numericSortCallback === undefined ? {} : { numericSortCallback }),
					...((flags & 1) === 0 ? {} : { directFunctionCall: true }),
					...((flags & 32) === 0 ? {} : { directStringCharCodeAtPosition: "inBounds" }),
					...((flags & 128) === 0
						? {}
						: {
								exactCollectionReceiver: guardedBuiltinCallBrandTag(collectionTag)!,
							}),
					...(guardedBuiltinCall === undefined ? {} : { guardedBuiltinCall }),
				};
			} else if (tag === 2 && instruction.opcode === "CONSTRUCT") {
				const directFunctionIndex = r.i32();
				if (
					directFunctionIndex < 0 ||
					directFunctionIndex >= functions.length ||
					directFunctionIndex !== instruction.exactFunctionIndex
				) {
					throw new RangeError(
						"program-image-codec: invalid CONSTRUCT compiler metadata",
					);
				}
				nativeInstructions[instructionIndex] = {
					kind: "construct",
					directFunctionIndex,
				};
			} else if (tag === 12 && instruction.opcode === "CREATE_ARRAY") {
				const reserveLength = r.i32();
				if (reserveLength < 1 || reserveLength > 65_536) {
					throw new RangeError(
						"program-image-codec: invalid indexed-fill reserve metadata",
					);
				}
				nativeInstructions[instructionIndex] = {
					kind: "fresh-dense-reserve",
					length: reserveLength,
				};
			} else if (
				tag === 14 &&
				(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
					instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
			) {
				if (
					String.fromCharCode(...(stringConstants[instruction.stringIndex] ?? [])) !==
					"length"
				) {
					throw new RangeError("program-image-codec: invalid exact Array length hint");
				}
				nativeInstructions[instructionIndex] = {
					kind: "exact-array-length",
				};
			} else if (tag === 15 && instruction.opcode === "LOAD_PROPERTY") {
				nativeInstructions[instructionIndex] = {
					kind: "exact-contained-array-element",
				};
			} else if (tag === 19 && instruction.opcode === "LOAD_PROPERTY") {
				const indexIsUint32 = r.u8();
				if (indexIsUint32 > 1) {
					throw new RangeError("program-image-codec: invalid packed rest index metadata");
				}
				nativeInstructions[instructionIndex] = {
					kind: "exact-packed-rest-array-element",
					indexIsUint32: indexIsUint32 === 1,
				};
			} else if (
				tag === 16 &&
				(instruction.opcode === "LOAD_PROPERTY" ||
					instruction.opcode === "STORE_PROPERTY")
			) {
				nativeInstructions[instructionIndex] = {
					kind: "exact-typed-array-element",
					elementKind: numericTypedArrayKindFromTag(r.u8()),
				};
			} else if (
				tag === 17 &&
				(instruction.opcode === "LOAD_PROPERTY" ||
					instruction.opcode === "STORE_PROPERTY")
			) {
				const elementKind = numericTypedArrayKindFromTag(r.u8());
				const inBounds = r.u8();
				if (inBounds > 1)
					throw new RangeError("program-image-codec: invalid typed array bounds proof");
				nativeInstructions[instructionIndex] = {
					kind: "contained-fixed-typed-array-element",
					elementKind,
					...(inBounds === 1 ? { inBounds: true } : {}),
				};
			} else if (
				tag === 18 &&
				(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
					instruction.opcode === "LOAD_PROPERTY_STATIC_ARRAY_LENGTH")
			) {
				if (
					String.fromCharCode(...(stringConstants[instruction.stringIndex] ?? [])) !==
					"length"
				) {
					throw new RangeError(
						"program-image-codec: invalid contained TypedArray length hint",
					);
				}
				nativeInstructions[instructionIndex] = {
					kind: "contained-fixed-typed-array-length",
				};
			} else if (tag === 11 && instruction.opcode === "LOAD_PROPERTY_STATIC") {
				if (
					String.fromCharCode(...(stringConstants[instruction.stringIndex] ?? [])) !==
					"length"
				) {
					throw new RangeError(
						"program-image-codec: invalid primitive-String length hint",
					);
				}
				nativeInstructions[instructionIndex] = {
					kind: "primitive-string-length",
				};
			} else if (
				tag === 13 &&
				(instruction.opcode === "LOAD_PROPERTY_STATIC" ||
					instruction.opcode === "LOAD_PROPERTY_STATIC_KNOWN_OWN_SLOT" ||
					instruction.opcode === "STORE_PROPERTY_STATIC" ||
					instruction.opcode === "STORE_PROPERTY_STATIC_KNOWN_OWN_SLOT")
			) {
				nativeInstructions[instructionIndex] = {
					kind: "exact-own-slot",
					slot: r.u32(),
				};
			} else if (
				tag === 18 &&
				instruction.opcode === "BINARY" &&
				["+", "-", "*", "%"].includes(instruction.operator)
			) {
				nativeInstructions[instructionIndex] = { kind: "unsigned-arithmetic" };
			} else if (
				tag === 19 &&
				instruction.opcode === "CALL_KNOWN" &&
				!instruction.construct &&
				instruction.argumentMode === undefined
			) {
				if (instruction.arguments.length > 16)
					throw new RangeError("program-image-codec: invalid builtin input count");
				const masks = Array.from({ length: instruction.arguments.length + 1 }, () =>
					r.u8(),
				);
				if (!compilerBuiltinInputKindsAreValid(masks, instruction.arguments.length + 1))
					throw new RangeError("program-image-codec: invalid builtin input kind masks");
				nativeInstructions[instructionIndex] = {
					kind: "exact-builtin-input-kinds",
					inputKindMasks: masks,
				};
			} else if (
				tag === 17 &&
				(instruction.opcode === "BINARY" || instruction.opcode === "UNARY")
			) {
				const masks: CompilerOperatorInputKindMasks =
					instruction.opcode === "BINARY" ? [r.u8(), r.u8()] : [r.u8()];
				if (
					!compilerOperatorInputKindsHaveExactNativeSemantics(
						instruction.opcode.toLowerCase(),
						instruction.operator,
						masks,
					)
				)
					throw new RangeError("program-image-codec: invalid exact operator kind masks");
				nativeInstructions[instructionIndex] = {
					kind: "exact-operator-input-kinds",
					inputKindMasks: masks,
				};
			} else {
				throw new RangeError(
					"program-image-codec: compiler instruction metadata opcode mismatch",
				);
			}
		}
		const regionCount = r.count(17);
		const regions: Array<VmRegion> = [];
		if (regionCount > 0) {
			const claimed = new Set<number>();
			for (let regionIndex = 0; regionIndex < regionCount; regionIndex++) {
				const kindTag = r.u8();
				const compositionTag = r.u8();
				const anchors = r.i32Array();
				const claimedIps = r.i32Array();
				const ordinaryBlockIps = r.i32Array();
				const exceptionalHandlerIps = r.i32Array();
				const score = r.u32();
				const metadataOperations = r.u32();
				const representationTag = r.u8();
				const genericTwinTag = r.u8();
				const materializationTag = r.u8();
				const dependencyMask = r.u8();
				const obligationMask = r.u8();
				const admissionTag = r.u8();
				const admissionAnchorIp = r.i32();
				const admission = {
					anchorIp: admissionAnchorIp,
					mode:
						admissionTag === 1
							? ("stable" as const)
							: admissionTag === 2
								? ("capture" as const)
								: ("per-use" as const),
				};
				const stringSplitCursorContract =
					kindTag === 2 &&
					representationTag === 2 &&
					materializationTag === 1 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3;
				const stringSplitProjectionContract =
					kindTag === 4 &&
					representationTag === 4 &&
					materializationTag === 2 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3;
				const regexpExecProjectionContract =
					kindTag === 5 &&
					representationTag === 5 &&
					materializationTag === 2 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3;
				const regexpIteratorProjectionContract =
					kindTag === 6 &&
					representationTag === 6 &&
					materializationTag === 1 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3;
				const stringSliceNumberContract =
					kindTag === 7 &&
					representationTag === 7 &&
					materializationTag === 0 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 1;
				const stackObjectPlanContract =
					kindTag === 11 &&
					representationTag === 11 &&
					[0, 1, 2].includes(dependencyMask) &&
					((materializationTag === 0 && obligationMask === 1) ||
						(materializationTag === 1 && obligationMask === 3));
				const numericFusionContract =
					kindTag === 14 &&
					representationTag === 14 &&
					materializationTag === 0 &&
					dependencyMask === 0 &&
					obligationMask === 1;
				const indexedLengthLoopContract =
					kindTag === 15 &&
					representationTag === 15 &&
					materializationTag === 0 &&
					dependencyMask === 0 &&
					obligationMask === 1;
				const stringCharCodeAtChainContract =
					kindTag === 16 &&
					representationTag === 16 &&
					materializationTag === 0 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 1 &&
					admissionTag === 2;
				const iteratorCursorContract =
					kindTag >= 17 &&
					kindTag <= 21 &&
					representationTag === kindTag &&
					materializationTag === 0 &&
					dependencyMask === 0 &&
					obligationMask === 1 &&
					admissionTag === 1;
				const iteratorResultVirtualizationContract =
					kindTag === 22 &&
					representationTag === 22 &&
					materializationTag === 1 &&
					dependencyMask === 0 &&
					obligationMask === 3 &&
					admissionTag === 1;
				const builtinCollectionCallChainContract =
					kindTag === 23 &&
					representationTag === 23 &&
					materializationTag === 0 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 1 &&
					admissionTag === 2;
				const iteratorEntryPairContract =
					kindTag === 24 &&
					representationTag === 24 &&
					materializationTag === 1 &&
					(dependencyMask === 1 || dependencyMask === 4) &&
					obligationMask === 3 &&
					admissionTag === 2;
				if (
					compositionTag > 1 ||
					(compositionTag === 1) !==
						(numericFusionContract ||
							iteratorResultVirtualizationContract ||
							iteratorEntryPairContract) ||
					genericTwinTag !== 1 ||
					admissionTag > 2 ||
					(!stringSplitCursorContract &&
						!stringSplitProjectionContract &&
						!regexpExecProjectionContract &&
						!regexpIteratorProjectionContract &&
						!stringSliceNumberContract &&
						!stackObjectPlanContract &&
						!numericFusionContract &&
						!indexedLengthLoopContract &&
						!stringCharCodeAtChainContract &&
						!iteratorCursorContract &&
						!iteratorResultVirtualizationContract &&
						!builtinCollectionCallChainContract &&
						!iteratorEntryPairContract)
				) {
					throw new RangeError("program-image-codec: invalid function region contract");
				}
				let region: VmRegion;
				if (kindTag === 2) {
					const propertyIp = r.i32();
					const propertyPlacement = readPropertyPlacement(r);
					const splitIdentityTag = r.u8();
					const trimIdentityTag = r.u8();
					const callee = r.i32();
					const receiver = r.i32();
					const separator = r.i32();
					const resultRegisters = r.i32Array();
					const index = r.i32();
					const elementIp = r.i32();
					const trimPropertyIp = r.i32();
					const trimIcIndex = r.i32();
					const trimCallIp = r.i32();
					const primitiveStringLengthIps = r.i32Array();
					const exitIp = r.i32();
					if (
						splitIdentityTag > 1 ||
						trimIdentityTag > 1 ||
						primitiveStringLengthIps.length > MAX_STRING_SPLIT_CURSOR_LENGTH_LOADS
					) {
						throw new RangeError(
							"program-image-codec: invalid String.split cursor header",
						);
					}
					region = {
						kind: "string-split-cursor",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [
												{
													kind: "world" as const,
													fact: "primordials.locked" as const,
												},
											]
										: [
												{
													kind: "epoch" as const,
													family: "watched-methods" as const,
												},
											],
								obligations: ["fallback" as const, "materialize" as const],
							},
							genericTwin: "retained",
							materialization: "on-demand",
							admission,
						},
						representation: "split-cursor-spans",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						propertyPlacement,
						splitIdentity:
							splitIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
						trimIdentity:
							trimIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
						callee,
						receiver,
						separator,
						resultRegisters,
						index,
						elementIp,
						trimPropertyIp,
						trimIcIndex,
						trimCallIp,
						primitiveStringLengthIps,
						exitIp,
					};
				} else if (kindTag === 4) {
					const propertyIp = r.i32();
					const propertyPlacement = readPropertyPlacement(r);
					const splitIdentityTag = r.u8();
					const callIp = r.i32();
					const callee = r.i32();
					const receiver = r.i32();
					const separatorIp = r.i32();
					const separatorStringIndex = r.i32();
					const resultRegisters = r.i32Array();
					if (splitIdentityTag > 1) {
						throw new RangeError(
							"program-image-codec: invalid String.split identity decision",
						);
					}
					const loadCount = r.count(4);
					const loads: Array<
						Extract<VmRegion, { kind: "string-split-projection" }>["loads"][number]
					> = [];
					for (let loadIndex = 0; loadIndex < loadCount; loadIndex++) {
						const ip = r.i32();
						const loadKindTag = r.u8();
						const keyIp = r.i32();
						const index = r.i32();
						const dst = r.i32();
						if (
							(loadKindTag !== 1 && loadKindTag !== 2) ||
							(loadKindTag === 2 && (keyIp !== -1 || index !== -1))
						) {
							throw new RangeError(
								"program-image-codec: invalid String.split projection load",
							);
						}
						loads.push(
							loadKindTag === 1
								? { ip, kind: "element", keyIp, index, dst }
								: { ip, kind: "length", dst },
						);
					}
					region = {
						kind: "string-split-projection",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [
												{
													kind: "world" as const,
													fact: "primordials.locked" as const,
												},
											]
										: [
												{
													kind: "epoch" as const,
													family: "watched-methods" as const,
												},
											],
								obligations: ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: "whole-region",
							admission,
						},
						representation: "projected-elements",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						propertyPlacement,
						splitIdentity:
							splitIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
						callIp,
						callee,
						receiver,
						separatorIp,
						separatorStringIndex,
						resultRegisters,
						loads,
					};
				} else if (kindTag === 5) {
					const propertyIp = r.i32();
					const propertyPlacement = readPropertyPlacement(r);
					const callIp = r.i32();
					const lockedFreshLiteral = r.u8();
					const constructorIntrinsicIp = r.i32();
					const constructIp = r.i32();
					const callee = r.i32();
					const receiver = r.i32();
					const input = r.i32();
					const result = r.i32();
					const resultRegisters = r.i32Array();
					const nullCheckCount = r.count(5);
					const nullChecks: Array<{
						comparisonIp: number;
						nullIp: number;
					}> = [];
					for (let check = 0; check < nullCheckCount; check++) {
						nullChecks.push({ comparisonIp: r.i32(), nullIp: r.i32() });
					}
					const lastIndexEffect = r.u8();
					const loadCount = r.count(4);
					const loads: Array<
						Extract<VmRegion, { kind: "regexp-exec-projection" }>["loads"][number]
					> = [];
					for (let loadIndex = 0; loadIndex < loadCount; loadIndex++) {
						const ip = r.i32();
						const keyIp = r.i32();
						const captureIndex = r.i32();
						const dst = r.i32();
						const consumerTag = r.u8();
						let consumer:
							| Extract<
									VmRegion,
									{ kind: "regexp-exec-projection" }
							  >["loads"][number]["consumer"]
							| undefined;
						if (consumerTag === 1) {
							consumer = { kind: "length", propertyIp: r.i32() };
						} else if (consumerTag === 2) {
							const propertyIp = r.i32();
							const callIp = r.i32();
							const zeroIp = r.i32();
							const methodIdentityTag = r.u8();
							if (methodIdentityTag > 1) {
								throw new RangeError(
									"program-image-codec: invalid projected String method identity",
								);
							}
							consumer = {
								kind: "charCodeAtZero",
								methodIdentity:
									methodIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
								propertyIp,
								callIp,
								...(zeroIp < 0 ? {} : { zeroIp }),
							};
						} else if (consumerTag === 3) {
							consumer = {
								kind: "number",
								intrinsicIp: r.i32(),
								callIp: r.i32(),
							};
						} else if (consumerTag === 4) {
							const upperPropertyIp = r.i32();
							const upperCallIp = r.i32();
							const lowerPropertyIp = r.i32();
							const lowerIcIndex = r.i32();
							const lowerCallIp = r.i32();
							const resultMoveIps = r.i32Array();
							const lengthPropertyIp = r.i32();
							const methodIdentityTag = r.u8();
							if (methodIdentityTag > 1) {
								throw new RangeError(
									"program-image-codec: invalid projected String method identity",
								);
							}
							consumer = {
								kind: "asciiCaseLength",
								methodIdentity:
									methodIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
								upperPropertyIp,
								upperCallIp,
								lowerPropertyIp,
								lowerIcIndex,
								lowerCallIp,
								resultMoveIps,
								lengthPropertyIp,
							};
						} else if (consumerTag !== 0) {
							throw new RangeError(
								"program-image-codec: invalid RegExp.exec consumer tag",
							);
						}
						loads.push({
							ip,
							keyIp,
							captureIndex,
							dst,
							...(consumer ? { consumer } : {}),
						});
					}
					if (
						lockedFreshLiteral > 1 ||
						lastIndexEffect !== 1 ||
						(lockedFreshLiteral === 0
							? constructorIntrinsicIp !== -1 || constructIp !== -1
							: constructorIntrinsicIp < 0 || constructIp < 0)
					) {
						throw new RangeError(
							"program-image-codec: invalid RegExp.exec projection header",
						);
					}
					region = {
						kind: "regexp-exec-projection",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: "whole-region",
							admission,
						},
						representation: "regexp-capture-spans",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						propertyPlacement,
						callIp,
						lockedFreshLiteral: lockedFreshLiteral === 1,
						...(lockedFreshLiteral === 0
							? {}
							: { lockedLiteral: { constructorIntrinsicIp, constructIp } }),
						callee,
						receiver,
						input,
						result,
						resultRegisters,
						nullChecks,
						lastIndexEffect: "retained-call-twin",
						loads,
					};
				} else if (kindTag === 6) {
					const stepIp = r.i32();
					const doneBranchIp = r.i32();
					const exitIp = r.i32();
					const iterator = r.i32();
					const next = r.i32();
					const value = r.i32();
					const done = r.i32();
					const resultRegisters = r.i32Array();
					const statefulEffect = r.u8();
					const runtimeGuard = r.u8();
					const loadCount = r.count(4);
					const loads: Array<
						Extract<VmRegion, { kind: "regexp-iterator-projection" }>["loads"][number]
					> = [];
					for (let load = 0; load < loadCount; load++) {
						loads.push({
							ip: r.i32(),
							keyIp: r.i32(),
							captureIndex: r.i32(),
							dst: r.i32(),
							numberIntrinsicIp: r.i32(),
							numberCallIp: r.i32(),
						});
					}
					if (statefulEffect !== 1 || runtimeGuard !== 1) {
						throw new RangeError(
							"program-image-codec: invalid RegExp iterator projection header",
						);
					}
					region = {
						kind: "regexp-iterator-projection",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: "on-demand",
							admission,
						},
						representation: "regexp-iterator-capture-spans",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						stepIp,
						doneBranchIp,
						exitIp,
						iterator,
						next,
						value,
						done,
						resultRegisters,
						statefulEffect: "iterator-last-index-retained-step",
						runtimeGuard: "exact-brand-next-realm-regexp",
						loads,
					};
				} else if (kindTag === 7) {
					const propertyIp = r.i32();
					const propertyPlacement = readPropertyPlacement(r);
					const builtinIdentitiesTag = r.u8();
					const sliceCallIp = r.i32();
					const sliceStartIp = r.i32();
					const numberIntrinsicIp = r.i32();
					const numberCallIp = r.i32();
					const numberCallee = r.i32();
					const receiver = r.i32();
					const sliceStart = r.f64();
					const result = r.i32();
					if (builtinIdentitiesTag > 1) {
						throw new RangeError(
							"program-image-codec: invalid String.slice identity decision",
						);
					}
					region = {
						kind: "string-slice-number",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback"],
							},
							genericTwin: "retained",
							materialization: "none",
							admission,
						},
						representation: "primitive-string-span-number",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						propertyPlacement,
						builtinIdentities:
							builtinIdentitiesTag === 1 ? "authority-invariant" : "runtime-guarded",
						sliceCallIp,
						sliceStartIp,
						numberIntrinsicIp,
						numberCallIp,
						numberCallee,
						receiver,
						sliceStart,
						result,
					};
				} else if (kindTag === 11) {
					const siteCount = r.count(5);
					if (siteCount === 0 || siteCount > 8) {
						throw new RangeError("program-image-codec: invalid stack-object site count");
					}
					const sites: Array<
						Extract<VmRegion, { kind: "stack-object-plan" }>["sites"][number]
					> = [];
					for (let siteIndex = 0; siteIndex < siteCount; siteIndex++) {
						const allocationIp = r.i32();
						const modeTag = r.u8();
						if (modeTag > 1) {
							throw new RangeError("program-image-codec: invalid stack-object mode");
						}
						const slotCount = r.i32();
						const accessCount = r.count(2);
						const accesses: Array<{ ip: number; slot: number }> = [];
						for (let access = 0; access < accessCount; access++) {
							accesses.push({ ip: r.i32(), slot: r.i32() });
						}
						const inheritedAccessIp = r.i32();
						const materializationCount = r.count(2);
						const materializations: Array<{ ip: number; kind: "return" }> = [];
						for (
							let materialization = 0;
							materialization < materializationCount;
							materialization++
						) {
							const ip = r.i32();
							const tag = r.u8();
							if (tag !== 1) {
								throw new RangeError(
									"program-image-codec: invalid stack-object materialization",
								);
							}
							materializations.push({
								ip,
								kind: "return",
							});
						}
						sites.push({
							allocationIp,
							mode: modeTag === 0 ? "elided" : "activation-local",
							slotCount,
							accesses,
							...(inheritedAccessIp < 0 ? {} : { inheritedAccessIp }),
							materializations,
						});
					}
					region = {
						kind: "stack-object-plan",
						license: {
							guard: {
								dependencies:
									dependencyMask === 0
										? []
										: dependencyMask === 1
											? [{ kind: "world", fact: "primordials.locked" }]
											: [{ kind: "epoch", family: "primitive-methods" }],
								obligations:
									materializationTag === 0 ? ["fallback"] : ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: materializationTag === 0 ? "none" : "on-demand",
							admission,
						},
						representation: "activation-local-fixed-shape-objects",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						sites,
					};
				} else if (kindTag === 14) {
					const runtimeGuardTag = r.u8();
					const pairCount = r.count(2);
					const pairs: Array<
						Extract<VmRegion, { kind: "numeric-fusion" }>["pairs"][number]
					> = [];
					for (let pair = 0; pair < pairCount; pair++) {
						const firstIp = r.i32();
						const finishIp = r.i32();
						const firstUsePosition = r.u8();
						if (firstUsePosition !== 1 && firstUsePosition !== 2) {
							throw new RangeError(
								"program-image-codec: invalid numeric-fusion use position",
							);
						}
						pairs.push({ firstIp, finishIp, firstUsePosition });
					}
					if (runtimeGuardTag !== 1) {
						throw new RangeError("program-image-codec: invalid numeric-fusion guard");
					}
					region = {
						kind: "numeric-fusion",
						license: {
							guard: { dependencies: [], obligations: ["fallback"] },
							genericTwin: "retained",
							materialization: "none",
							admission,
						},
						representation: "binary-pairs-f64",
						composition: "overlay",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						runtimeGuard: "number-operands",
						pairs,
					};
				} else if (kindTag === 15) {
					const runtimeGuardTag = r.u8();
					const siteCount = r.count(2);
					const sites: Array<
						Extract<VmRegion, { kind: "indexed-length-loop" }>["sites"][number]
					> = [];
					for (let site = 0; site < siteCount; site++) {
						const loadIp = r.i32();
						const comparisonIp = r.i32();
						const lengthPosition = r.u8();
						const elementCount = r.count(2);
						const elements: Array<{
							ip: number;
							kind: "load" | "store";
							arrayIndexIsUint32: boolean;
						}> = [];
						for (let element = 0; element < elementCount; element++) {
							const ip = r.i32();
							const kindTag = r.u8();
							const arrayIndexTag = r.u8();
							if ((kindTag !== 1 && kindTag !== 2) || arrayIndexTag > 1) {
								throw new RangeError(
									"program-image-codec: invalid array-length element kind",
								);
							}
							elements.push({
								ip,
								kind: kindTag === 1 ? "load" : "store",
								arrayIndexIsUint32: arrayIndexTag === 1,
							});
						}
						if (lengthPosition !== 1 && lengthPosition !== 2) {
							throw new RangeError(
								"program-image-codec: invalid array-length operand position",
							);
						}
						sites.push({
							loadIp,
							comparisonIp,
							lengthPosition,
							elements,
						});
					}
					if (runtimeGuardTag !== 1) {
						throw new RangeError(
							"program-image-codec: invalid indexed-length-loop guard",
						);
					}
					region = {
						kind: "indexed-length-loop",
						license: {
							guard: { dependencies: [], obligations: ["fallback"] },
							genericTwin: "retained",
							materialization: "none",
							admission,
						},
						representation: "live-indexed-length-loops",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						runtimeGuard: "array-or-numeric-typed-array",
						sites,
					};
				} else if (kindTag === 16) {
					const propertyIp = r.i32();
					const callIp = r.i32();
					const methodIdentityTag = r.u8();
					const runtimeGuardTag = r.u8();
					const evaluationOrderTag = r.u8();
					const propertyIcIndex = r.i32();
					const callee = r.i32();
					const receiver = r.i32();
					const result = r.i32();
					if (
						methodIdentityTag > 1 ||
						runtimeGuardTag !== 1 ||
						evaluationOrderTag !== 1
					) {
						throw new RangeError(
							"program-image-codec: invalid String.charCodeAt chain header",
						);
					}
					region = {
						kind: "string-char-code-at-chain",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback"],
							},
							genericTwin: "retained",
							materialization: "none",
							admission,
						},
						representation: "primitive-string-code-unit",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						callIp,
						methodIdentity:
							methodIdentityTag === 1 ? "authority-invariant" : "runtime-guarded",
						runtimeGuard: "primitive-string-number-position",
						evaluationOrder: "capture-property-before-arguments",
						propertyIcIndex,
						callee,
						receiver,
						result,
					};
				} else if (kindTag >= 17 && kindTag <= 21) {
					const initializeIp = r.i32();
					const stepIps = r.i32Array();
					const iterator = r.i32();
					const next = r.i32();
					const runtimeGuardTag = r.u8();
					const stateSynchronizationTag = r.u8();
					const suspensionTag = r.u8();
					if (
						runtimeGuardTag !== 1 ||
						stateSynchronizationTag !== 1 ||
						suspensionTag !== 1
					) {
						throw new RangeError("program-image-codec: invalid iterator cursor header");
					}
					const common = {
						license: {
							guard: { dependencies: [], obligations: ["fallback" as const] },
							genericTwin: "retained" as const,
							materialization: "none" as const,
							admission,
						},
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						initializeIp,
						stepIps,
						iterator,
						next,
						runtimeGuard: "exact-iterator-brand-next-target" as const,
						stateSynchronization: "authoritative-language-object" as const,
						suspension: "forbidden" as const,
					};
					if (kindTag === 17) {
						region = {
							...common,
							kind: "array-values-iterator-cursor",
							representation: "array-values-authoritative-cursor",
							protocol: "array-values",
						};
					} else if (kindTag === 18) {
						region = {
							...common,
							kind: "string-iterator-cursor",
							representation: "string-authoritative-cursor",
							protocol: "string",
						};
					} else if (kindTag === 19) {
						region = {
							...common,
							kind: "typed-array-iterator-cursor",
							representation: "typed-array-authoritative-cursor",
							protocol: "typed-array-values",
						};
					} else if (kindTag === 20) {
						region = {
							...common,
							kind: "map-iterator-cursor",
							representation: "map-authoritative-cursor",
							protocol: "map",
						};
					} else {
						region = {
							...common,
							kind: "set-iterator-cursor",
							representation: "set-authoritative-cursor",
							protocol: "set",
						};
					}
				} else if (kindTag === 22) {
					const stepIps = r.i32Array();
					const runtimeGuardTag = r.u8();
					const correspondenceTag = r.u8();
					const fallbackTag = r.u8();
					if (runtimeGuardTag !== 1 || correspondenceTag !== 1 || fallbackTag !== 1) {
						throw new RangeError(
							"program-image-codec: invalid iterator-result virtualization header",
						);
					}
					region = {
						kind: "iterator-result-virtualization",
						license: {
							guard: {
								dependencies: [],
								obligations: ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: "on-demand",
							admission,
						},
						representation: "virtual-iterator-result",
						composition: "overlay",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						stepIps,
						runtimeGuard: "exact-builtin-iterator-next",
						correspondence: "done-value-observation",
						fallback: "materialize-result-then-observe",
					};
				} else if (kindTag === 23) {
					const propertyIp = r.i32();
					const callIp = r.i32();
					const operation = collectionOperationFromTag(r.u8());
					const runtimeGuardTag = r.u8();
					const evaluationOrderTag = r.u8();
					const propertyIcIndex = r.i32();
					const callee = r.i32();
					const receiver = r.i32();
					const result = r.i32();
					if (runtimeGuardTag !== 1 || evaluationOrderTag !== 1) {
						throw new RangeError(
							"program-image-codec: invalid builtin collection chain header",
						);
					}
					region = {
						kind: "builtin-collection-call-chain",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback"],
							},
							genericTwin: "retained",
							materialization: "none",
							admission,
						},
						representation: "captured-collection-method",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						propertyIp,
						callIp,
						operation,
						runtimeGuard: "exact-collection-method",
						evaluationOrder: "capture-property-before-arguments",
						propertyIcIndex,
						callee,
						receiver,
						result,
					};
				} else if (kindTag === 24) {
					const cursorInitializeIp = r.i32();
					const outerStepIp = r.i32();
					const innerInitializeIp = r.i32();
					const innerStepIps = r.i32Array();
					const innerCloseIps = r.i32Array();
					const runtimeGuardTag = r.u8();
					const correspondenceTag = r.u8();
					const synchronizationTag = r.u8();
					const fallbackTag = r.u8();
					if (
						innerStepIps.length !== 2 ||
						innerCloseIps.length > 8 ||
						runtimeGuardTag !== 1 ||
						correspondenceTag !== 1 ||
						synchronizationTag !== 1 ||
						fallbackTag !== 1
					) {
						throw new RangeError(
							"program-image-codec: invalid iterator entry-pair header",
						);
					}
					region = {
						kind: "iterator-entry-pair-virtualization",
						license: {
							guard: {
								dependencies:
									dependencyMask === 1
										? [{ kind: "world", fact: "primordials.locked" }]
										: [{ kind: "epoch", family: "watched-methods" }],
								obligations: ["fallback", "materialize"],
							},
							genericTwin: "retained",
							materialization: "on-demand",
							admission,
						},
						representation: "virtual-iterator-entry-pair",
						composition: "overlay",
						anchors,
						claimedIps,
						controlFlow: { ordinaryBlockIps, exceptionalHandlerIps },
						cost: { score, metadataOperations },
						cursorInitializeIp,
						outerStepIp,
						innerInitializeIp,
						innerStepIps: [innerStepIps[0]!, innerStepIps[1]!],
						innerCloseIps,
						runtimeGuard: "exact-entry-pair-cursor",
						correspondence: "entry-pair-elements",
						stateSynchronization: "authoritative-language-object",
						fallback: "materialize-entry-pair-then-iterate",
					};
				} else {
					throw new RangeError("program-image-codec: invalid function region kind");
				}
				validateRegion(
					fn,
					region,
					claimed,
					stringConstants,
					nativeInstructions,
					registerRepresentations,
				);
				regions.push(region);
			}
		}
		const nativeFunction: NativeFunctionPlan = {
			...(specializedOnly ? { specializedOnly: true as const } : {}),
			functionIndex,
			mode: fn.isGenerator || fn.isAsync ? "resumable" : "direct",
			registerRepresentations,
			directEntries,
			...(fieldCallCount === 0 ? {} : { fieldCalls }),
			...(literalSwitchCount === 0 ? {} : { literalSwitches }),
			gc: { safepoints },
			instructions: nativeInstructions,
			specializations: regions,
			regionActions: vmRegionActions(regions),
		};
		nativeFrameRootRegisters(fn, nativeFunction);
		nativeFunctions.push(nativeFunction);
	}
	for (const native of nativeFunctions) {
		validateNativeFieldCalls(functions[native.functionIndex]!, native, nativeFunctions);
		validateNativeLiteralSwitches(functions[native.functionIndex]!, native);
		for (const plan of native.instructions) {
			if (plan?.kind !== "call") continue;
			if (plan.numericSortCallback !== undefined)
				validateNativeNumericSortCallback(plan.numericSortCallback, nativeFunctions);
			if (plan.directEntryId !== undefined) {
				const target =
					plan.directFunctionIndex ??
					(plan.guardedFunctionIndices?.length === 1
						? plan.guardedFunctionIndices[0]
						: undefined);
				if (
					target === undefined ||
					nativeFunctions[target]?.directEntries[plan.directEntryId]?.id !==
						plan.directEntryId
				) {
					throw new RangeError(
						"program-image-codec: direct-entry call names an unknown ABI",
					);
				}
			}
		}
	}
	if (r.remaining() !== 0) {
		throw new Error("program-image-codec: trailing data");
	}

	const definition: ProgramImage = {
		runtime: runtimeImage,
		native: { semanticProtectors, functions: nativeFunctions },
		diagnostics: {},
	};
	validateVmShapeCases(runtimeImage);
	return definition;
}
