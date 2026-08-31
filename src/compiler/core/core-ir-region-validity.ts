/**
 * How often a region's admission condition has to be checked.
 *
 * A guarded region names the semantic epochs its fast path depends on. Admitting
 * them is one runtime test; keeping them admitted is a proof obligation about the
 * region's interior. `per-use` says every licensed use re-tests the condition,
 * which is always correct. `stable` says the admission at the region's anchor
 * remains valid for every licensed use.
 *
 * `stable` is only claimable when the interior cannot reach a seam that invalidates
 * a named epoch. The proof is re-derived from the Core effect model and the
 * control-flow graph rather than trusted from the pass that made the claim, so a
 * later transform that drops an instruction into a licensed interior turns the
 * certificate into a verification failure instead of a miscompile.
 */

import type { FactDependency } from "../shared/fact-implication.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type {
	CoreAttributeObject,
	CoreBlockId,
	CoreEffectDomain,
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreOpcodeRegistry,
	CoreRegion,
	CoreValueId,
} from "./core-ir.ts";

export type CoreRegionAdmissionMode = "capture" | "stable" | "per-use";

export const CORE_REGION_ADMISSION_MODES: ReadonlyArray<CoreRegionAdmissionMode> = [
	"capture",
	"stable",
	"per-use",
];

/** Region-certificate admission record, in Core identities. */
export interface CoreRegionAdmission {
	readonly anchor: CoreInstructionId;
	readonly mode: CoreRegionAdmissionMode;
}

/**
 * Write domains that can reach a semantic-epoch bump. The runtime bumps a family
 * only from the object metaobject-protocol seams — prototype reparenting, own
 * property define/delete/set, shaped append, and the two inline-cache transition
 * stores — so a write to activation-local memory or a global *slot* cannot
 * invalidate one. `host` and `io` stand for effects this record cannot attribute
 * and are therefore always invalidating.
 *
 * Allocation and collection are deliberately absent: no GC, finalization, or
 * allocation path bumps a semantic family, so `mayGc` says nothing about epoch
 * stability.
 */
const EPOCH_INVALIDATING_WRITES: ReadonlySet<CoreEffectDomain> =
	new Set<CoreEffectDomain>([
		"object-property",
		"array-element",
		"global-property",
		"host",
		"io",
	]);

const SCALAR_REPRESENTATIONS: ReadonlySet<string> = new Set(["f64", "i32", "boolean"]);

/**
 * Per-function facts the validity proof needs, computed once in O(instructions).
 *
 * Region interiors are near-disjoint and every region re-reads the same
 * instructions, so the transparency bit and the two position maps are shared
 * rather than recomputed per region.
 */
export interface CoreRegionValidityModel {
	readonly transparent: ReadonlySet<CoreInstructionId>;
	readonly blockOf: ReadonlyMap<CoreInstructionId, CoreBlockId>;
	/** Instruction order inside a block; terminators sort after every instruction. */
	readonly orderInBlock: ReadonlyMap<CoreInstructionId, number>;
}

/**
 * Whether an instruction can reach a seam that invalidates a semantic epoch.
 *
 * The question is asked of effect domains, never of opcode names, so an operation
 * whose effects a landed fact has already refined — an own-data-cell access, a
 * call with an interprocedural summary — answers with its refined effects. A
 * suspension is opaque by construction: the resumed continuation runs arbitrary
 * code that this record does not describe.
 */
export function coreInstructionEpochTransparent(
	fn: CoreFunction,
	instruction: CoreInstruction,
	registry?: CoreOpcodeRegistry,
): boolean {
	const effects =
		registry === undefined
			? coreInstructionEffects(instruction)
			: coreInstructionEffects(instruction, registry);
	if (effects.maySuspend) return false;
	// `binary` and `unary` are in the user-code class because a boxed operand can
	// carry a `valueOf`/`toString` hook. An operand already held in an unboxed
	// scalar representation has no such hook, and this admission is what keeps
	// ordinary interior arithmetic from making every real loop body opaque.
	const scalarArithmetic =
		(instruction.opcode === "binary" || instruction.opcode === "unary") &&
		instruction.inputs.every((input) => coreValueIsScalar(fn, input));
	if (!scalarArithmetic && effects.callsUserCode) return false;
	return !effects.writes.some(
		(domain) =>
			EPOCH_INVALIDATING_WRITES.has(domain) && !(scalarArithmetic && domain === "host"),
	);
}

function coreValueIsScalar(fn: CoreFunction, value: CoreValueId): boolean {
	return SCALAR_REPRESENTATIONS.has(fn.values[value]?.representation ?? "boxed");
}

export function coreRegionValidityModel(
	fn: CoreFunction,
	registry?: CoreOpcodeRegistry,
): CoreRegionValidityModel {
	const transparent = new Set<CoreInstructionId>();
	const blockOf = new Map<CoreInstructionId, CoreBlockId>();
	const orderInBlock = new Map<CoreInstructionId, number>();
	for (const block of fn.blocks) {
		for (const [order, instruction] of block.instructions.entries()) {
			blockOf.set(instruction.id, block.id);
			orderInBlock.set(instruction.id, order);
			if (coreInstructionEpochTransparent(fn, instruction, registry)) {
				transparent.add(instruction.id);
			}
		}
		// Terminators are structural Core concepts rather than opcodes: none of them
		// reads or writes memory, so a terminator never invalidates an epoch. An edge
		// that leaves the interior ends the licensed extent instead of extending it.
		blockOf.set(block.terminator.id, block.id);
		orderInBlock.set(block.terminator.id, block.instructions.length);
		transparent.add(block.terminator.id);
	}
	return { transparent, blockOf, orderInBlock };
}

function attributeObject(value: unknown): CoreAttributeObject | undefined {
	if (value === null || typeof value !== "object" || Array.isArray(value))
		return undefined;
	return value as CoreAttributeObject;
}

/** The region certificate's license, or `undefined` when it is not readable data. */
export function coreRegionLicense(region: CoreRegion): CoreAttributeObject | undefined {
	return attributeObject(region.data.license);
}

/**
 * The epoch families a region's license depends on, or `undefined` when the
 * license cannot be read as a requirement pair. An unreadable license is never
 * treated as an empty one: the caller degrades to `per-use`.
 *
 * A license whose guard is the literal `"structural"` names no world or epoch
 * dependency at all — its fast path is licensed by a local operand test — so it
 * reads as the empty family set.
 */
export function coreRegionLicenseEpochFamilies(
	region: CoreRegion,
): ReadonlySet<string> | undefined {
	const license = coreRegionLicense(region);
	if (license === undefined) return undefined;
	if (license.guard === "structural") return new Set();
	const guard = attributeObject(license.guard);
	const dependencies = guard?.dependencies;
	if (!Array.isArray(dependencies)) return undefined;
	const families = new Set<string>();
	for (const entry of dependencies) {
		const dependency = attributeObject(entry);
		if (typeof dependency?.kind !== "string") return undefined;
		if (dependency.kind !== "epoch") continue;
		if (typeof dependency.family !== "string") return undefined;
		families.add(dependency.family);
	}
	return families;
}

/** The region's admission record, or `undefined` when the certificate lacks one. */
export function coreRegionAdmission(region: CoreRegion): CoreRegionAdmission | undefined {
	const admission = attributeObject(coreRegionLicense(region)?.admission);
	if (admission === undefined) return undefined;
	const anchor = attributeObject(admission.anchor)?.$coreInstruction;
	const mode = admission.mode;
	if (
		typeof anchor !== "number" ||
		(mode !== "capture" && mode !== "stable" && mode !== "per-use")
	) {
		return undefined;
	}
	return { anchor: anchor as CoreInstructionId, mode };
}

/**
 * The interior and license facts the validity proof reads. Selection passes hold
 * these directly; the verifier reads them back out of a finished certificate.
 */
export interface CoreRegionAdmissionQuery {
	readonly anchor: CoreInstructionId;
	/** `undefined` when the license could not be read as a requirement pair. */
	readonly epochFamilies: ReadonlySet<string> | undefined;
	readonly claimedInstructions: ReadonlyArray<CoreInstructionId>;
	readonly ordinaryBlocks: ReadonlyArray<CoreBlockId>;
	readonly exceptionalBlocks: ReadonlyArray<CoreBlockId>;
}

/** Epoch families named by a requirement pair a pass already holds unencoded. */
export function coreEpochFamilies(
	dependencies: ReadonlyArray<FactDependency>,
): ReadonlySet<string> {
	const families = new Set<string>();
	for (const dependency of dependencies) {
		if (dependency.kind === "epoch") families.add(dependency.family);
	}
	return families;
}

/** Read a finished certificate back into the facts the proof needs. */
export function coreRegionAdmissionQuery(
	region: CoreRegion,
	anchor: CoreInstructionId,
): CoreRegionAdmissionQuery {
	return {
		anchor,
		epochFamilies: coreRegionLicenseEpochFamilies(region),
		claimedInstructions: region.claimedInstructions,
		ordinaryBlocks: region.ordinaryBlocks,
		exceptionalBlocks: region.exceptionalBlocks,
	};
}

/**
 * Whether the declared interior keeps its admitted epochs valid from the anchor
 * through every licensed use.
 *
 * All four conditions are needed, and each one closes a distinct escape:
 *
 * 1. The anchor is inside the interior, its block dominates every licensed
 *    instruction, and no same-block claim precedes it, so no licensed use runs
 *    before admission on any path.
 * 2. Every edge into an interior block other than the anchor's — ordinary or
 *    exceptional — comes from the interior, so control cannot re-enter after a
 *    detour through code the proof never examined. The anchor's own block may be
 *    entered from anywhere, because entering it runs the anchor.
 * 3. The anchor's block does not throw into the interior, which would otherwise
 *    reach a licensed use while skipping the anchor.
 * 4. Every interior instruction other than the anchor is epoch-transparent.
 *
 * Claimed instructions are deliberately *not* exempt from condition 4. A claim
 * says the certificate owns the instruction, not that its licensed form is total:
 * a fast operation that declines at runtime falls back to its retained generic
 * twin, which can run arbitrary user code inside the interior.
 *
 * Cost is O(|interior blocks| + |interior instructions| + |interior edges|) with
 * the shared model precomputed, and `cfg.dominates` is a constant-time query.
 */
export function coreRegionInteriorKeepsAdmission(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	model: CoreRegionValidityModel,
	query: CoreRegionAdmissionQuery,
): boolean {
	const interior = new Set<CoreBlockId>([
		...query.ordinaryBlocks,
		...query.exceptionalBlocks,
	]);
	const anchorBlock = model.blockOf.get(query.anchor);
	if (anchorBlock === undefined || !interior.has(anchorBlock)) return false;
	const anchorOrder = model.orderInBlock.get(query.anchor);
	if (anchorOrder === undefined) return false;
	for (const claimed of query.claimedInstructions) {
		const claimedBlock = model.blockOf.get(claimed);
		const claimedOrder = model.orderInBlock.get(claimed);
		if (
			claimedBlock === undefined ||
			claimedOrder === undefined ||
			!interior.has(claimedBlock) ||
			!cfg.dominates(anchorBlock, claimedBlock) ||
			(claimedBlock === anchorBlock && claimedOrder < anchorOrder)
		) {
			return false;
		}
	}
	const anchorHandler = fn.blocks[anchorBlock]?.handler;
	if (anchorHandler !== undefined && interior.has(anchorHandler.block)) return false;
	for (const block of interior) {
		if (!cfg.dominates(anchorBlock, block)) return false;
		if (block !== anchorBlock) {
			for (const edge of cfg.predecessors[block] ?? []) {
				if (!interior.has(edge.from)) return false;
			}
		}
		for (const instruction of fn.blocks[block]?.instructions ?? []) {
			if (instruction.id === query.anchor) continue;
			if (!model.transparent.has(instruction.id)) return false;
		}
	}
	return true;
}

/**
 * Classify a region's admission mode from its license and its interior.
 *
 * A license that names no epoch family has nothing an interior could invalidate,
 * so `stable` holds without an interior proof: a world dependency such as locked
 * primordials cannot change while the program runs, and a purely structural
 * license re-tests its operands at each use anyway. Everything else must earn
 * `stable`, and an unreadable license earns nothing.
 */
export function coreRegionAdmissionMode(
	fn: CoreFunction,
	cfg: CoreControlFlow,
	model: CoreRegionValidityModel,
	query: CoreRegionAdmissionQuery,
): CoreRegionAdmissionMode {
	if (query.epochFamilies === undefined) return "per-use";
	if (query.epochFamilies.size === 0) return "stable";
	return coreRegionInteriorKeepsAdmission(fn, cfg, model, query) ? "stable" : "per-use";
}
