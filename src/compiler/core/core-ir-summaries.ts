/**
 * Interprocedural summaries over the bounded callee-target lattice.
 *
 * One analysis, four independent dimensions: transitive effects, parameter and
 * receiver escape, return provenance, and return representation. Every dimension
 * is a may-property whose least fixed point starts at bottom and only rises, so
 * the solve terminates on any graph, including a recursive one, and a dimension
 * that cannot be proven saturates on its own without dragging the others up with
 * it.
 *
 * Structure:
 *
 *   1. `analyzeCoreCalleeTargets` resolves callees once. This module never
 *      re-derives a callee: the lattice, its cap, and its opacity bit are the
 *      single authority, so a summary consumer and a dispatch consumer can never
 *      disagree about which functions a site reaches.
 *   2. One local pass per function collects everything independent of a callee:
 *      own effects, call sites with a closed finite target set, escape forwarding
 *      edges, and return sites.
 *   3. The call graph is condensed with an iterative Kosaraju — explicit stacks,
 *      never recursion, because a self-hosted program's call graph nests far
 *      deeper than the JS stack tolerates and an overflow inside an analysis is
 *      indistinguishable from a compiler bug.
 *   4. Components are solved in reverse topological order, callees before
 *      callers, with a local worklist inside each cyclic component. An acyclic
 *      component converges in one visit and nothing re-scans the whole program.
 *
 * Complexity: the target solve is O(cap * program). Condensation is O(V + E).
 * Every dimension has fixed height — nine domains, four flags, a four-point
 * escape chain, a six-point provenance lattice, a five-point representation
 * lattice — except the per-parameter escape vector, whose height is the
 * function's arity. One transfer costs O(function + arity), including the
 * bucketed prefix join that attributes `arguments` observations to the formals,
 * so a function's transfer runs O(height) times per incoming edge, for
 * O(cap * program + Σ_component |component| * height * in-degree). No
 * whole-program round exists.
 *
 * Bounded dimensions, all of which degrade rather than lie: the target-set cap
 * (`CORE_CALLEE_TARGET_CAP`) widens to `anyScript`, which makes a site
 * unresolvable; `CORE_SUMMARY_COMPONENT_ITERATION_LIMIT` saturates a component
 * that has not converged; and every argument past the declared formals collapses
 * into one rest-escape fact.
 *
 * Summaries are never serialized. Function indices are compilation-local and
 * rebase across definition merges, and an eval fragment is a separate program
 * whose callers are not in this graph, so a summary-derived proof is recomputed
 * per compilation and re-proved at the whole-program verifier boundary.
 */

import type {
	EffectDomain,
	EffectSummary,
	FunctionEffectSummary,
	ModuleEffectSummary,
	ReturnProvenance,
	ReturnRepresentation,
	SummaryRootReason,
	ValueContainmentFact,
	ValueEscapeFact,
} from "../shared/effect-summary.ts";
import {
	EFFECT_DOMAINS,
	EVERY_EFFECT_SUMMARY,
	NO_EFFECT_SUMMARY,
	RETURN_PROVENANCE_NONE,
	RETURN_PROVENANCE_UNKNOWN,
	effectSummariesEqual,
	effectSummaryCovers,
	effectSummaryKey,
	functionSummaryId,
	joinEffectSummaries,
	joinReturnProvenance,
	joinReturnRepresentation,
	joinValueContainment,
	joinValueEscape,
	moduleSummaryId,
	normalizeEffectDomains,
	normalizeRootReasons,
	returnProvenanceKey,
} from "../shared/effect-summary.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	analyzeCoreCalleeTargets,
	coreCalleeTargetsAreOpen,
	coreCalleeTargetsClosedFunction,
} from "./core-ir-call-targets.ts";
import type { CoreCalleeTargetAnalysis } from "./core-ir-call-targets.ts";
import { coreInstructionEffects, coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import type {
	CoreAttributeObject,
	CoreBlock,
	CoreFunction,
	CoreInstruction,
	CoreInstructionId,
	CoreOpcodeCallTransfer,
	CoreOpcodeRegistry,
	CoreProgram,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";

/** Fact kind a call site's summary-derived effect refinement names as its proof. */
export const CORE_CALL_EFFECT_SUMMARY_FACT = "callee-effect-summary";

/** Proof-carrying call value facts consumed only inside Core. */
export const CORE_CALL_SUMMARY_ATTRIBUTE = "calleeSummary";

/** Summary metadata that must not cross the Core-to-target boundary. */
export const CORE_INTERNAL_SUMMARY_ATTRIBUTES: ReadonlySet<string> = new Set([
	CORE_CALL_SUMMARY_ATTRIBUTE,
]);

/**
 * Transfer evaluations one strongly connected component may spend per member
 * before every member saturates to the conservative top of each dimension. The
 * fixed height of the dimensions already guarantees convergence, so this never
 * fires on a well-formed graph; it exists so a future dimension with an
 * unnoticed non-monotone transfer degrades to a sound answer instead of looping.
 */
export const CORE_SUMMARY_COMPONENT_ITERATION_LIMIT = 64;

/**
 * What entering a call does regardless of the callee's body: it pushes a frame,
 * which the runtime rejects with a `RangeError` once the stack is exhausted, and
 * it allocates the callee's activation.
 *
 * `mayThrow` here is why no ordinary call can ever be refined to non-throwing,
 * however pure its callee: recursion depth is a property of the caller chain, not
 * of the callee, so stack exhaustion is observable at every call site.
 */
export const CORE_CALL_FRAME_EFFECTS: EffectSummary = Object.freeze({
	reads: Object.freeze([]),
	writes: Object.freeze([]),
	mayThrow: true,
	maySuspend: false,
	mayGc: true,
	callsUserCode: false,
});

/**
 * The registry's declaration of the callable an instruction enters, which is how
 * this module decides what is a call graph edge and which sites a claim can
 * describe.
 *
 * A declared transfer is always a call-graph edge, so a callee reached only
 * through one is still summarized and still counted as a callee. A transfer whose
 * result the registry leaves `unmodeled` — super construction, which marshals its
 * argument list through an array, binds its result as `this`, and maps no operand
 * onto a formal — contributes the edge and nothing else: its effects, operands,
 * and result stay at their conservative baseline. Deriving both from the registry
 * is what keeps this call graph and the callee-target lattice from disagreeing
 * about which opcodes are calls.
 *
 * Only `call` participates in effect refinement on top of that. `construct`
 * additionally reads the constructor's `prototype` property and runs
 * derived-constructor and `this`-binding semantics this slice does not summarize,
 * and the spread forms marshal an argument list whose fan-out into parameters is
 * not statically known.
 */
function callTransfer(
	instruction: CoreInstruction,
	registry: CoreOpcodeRegistry,
): CoreOpcodeCallTransfer | undefined {
	return registry.get(instruction.opcode)?.callTransfer;
}

/**
 * How an opcode's results stand for the arguments this frame was handed.
 *
 * `positionAttribute` names the attribute holding the first argument position the
 * first result covers; `exact` marks a result that is that one argument rather
 * than an aggregate of it and everything after it. Any further result is an
 * arguments object the opcode materializes on the side — `loadStaticArgument`
 * threads its lazily built fallback cache through its second output — so it
 * aggregates the whole list.
 *
 * The invariant every attribution below rests on: for each supplied position `i`,
 * `arguments[i]` and the initial value of formal parameter `i` are the same
 * reference, mapped or not. Observing one is therefore observing the other, so an
 * exact result attributes to formal `i` alone and an aggregate covering
 * `[from, ∞)` attributes to every formal at or after `from` plus the rest bucket.
 * A producer whose position attribute is missing or malformed degrades to
 * `[0, ∞)`, never to a narrower guess.
 */
const ARGUMENT_PRODUCERS: Readonly<
	Record<
		string,
		{ readonly positionAttribute?: string; readonly exact?: boolean } | undefined
	>
> = {
	createArgumentsObject: {},
	createRestArguments: { positionAttribute: "startIndex" },
	loadArgument: { positionAttribute: "index", exact: true },
	loadStaticArgument: { positionAttribute: "index", exact: true },
};

/**
 * Opcodes whose result is a primitive by construction, so a function returning
 * one cannot hand back a reference to anything.
 *
 * `binary` and `unary` are included for the same reason the registry excludes
 * their results from weak holding: no JavaScript operator evaluates to an object
 * or a symbol.
 */
const PRIMITIVE_RESULT_OPCODES: ReadonlySet<string> = new Set([
	"binary",
	"createBigint",
	"createBoolean",
	"createF64",
	"createNull",
	"createNumber",
	"createPrivateName",
	"createString",
	"createUndefined",
	"isEmpty",
	"loadArgumentCount",
	"mathBinaryNumber",
	"mathUnaryNumber",
	"typeofCompare",
	"unary",
]);

/**
 * Allocations whose result is a reference no caller can already hold.
 *
 * `createTemplateObject` is deliberately absent: it returns the object cached in
 * its site's global slot, so every evaluation past the first hands back an
 * identity a caller may already hold.
 */
const FRESH_IDENTITY_OPCODES: ReadonlySet<string> = new Set([
	"createArgumentsObject",
	"createArray",
	"createFunction",
	"createModuleNamespace",
	"createObject",
	"createObjectShaped",
	"createRestArguments",
	"instantiateLiteralTemplate",
]);

export interface CoreFunctionSummary {
	readonly functionIndex: number;
	readonly sourcePath: string;
	/** Transitive: every callee this analysis could name is already folded in. */
	readonly effects: EffectSummary;
	/** Named script callees, sorted; an unnamed edge shows up as `openCallEdge`. */
	readonly callees: ReadonlyArray<number>;
	readonly openCallEdge: boolean;
	readonly rootReasons: ReadonlyArray<SummaryRootReason>;
	readonly externallyReachable: boolean;
	readonly parameterEscape: ReadonlyArray<ValueEscapeFact>;
	readonly restParameterEscape: ValueEscapeFact;
	readonly receiverEscape: ValueEscapeFact;
	readonly parameterContainment: ReadonlyArray<ValueContainmentFact>;
	readonly restParameterContainment: ValueContainmentFact;
	readonly receiverContainment: ValueContainmentFact;
	readonly returnProvenance: ReturnProvenance;
	readonly returnRepresentation: ReturnRepresentation;
}

export interface CoreModuleSummary {
	readonly sourcePath: string;
	readonly effects: EffectSummary;
	readonly functions: ReadonlyArray<number>;
	readonly externallyReachable: boolean;
	readonly evaluated: boolean;
}

/** The claim a refinement records, and the only thing its digest binds. */
export interface CoreCallSummaryClaim {
	readonly targets: ReadonlyArray<number>;
	/** Joined transitive callee effects, including the call's own frame cost. */
	readonly effects: EffectSummary;
	/** Escape of the ordinary call's receiver and each supplied argument. */
	readonly receiverEscape: ValueEscapeFact;
	readonly argumentEscape: ReadonlyArray<ValueEscapeFact>;
	readonly receiverContainment: ValueContainmentFact;
	readonly argumentContainment: ReadonlyArray<ValueContainmentFact>;
	/** Joined result facts before substituting the caller's actual operands. */
	readonly returnProvenance: ReturnProvenance;
	readonly returnRepresentation: ReturnRepresentation;
}

/** Effect-only claim persisted in a Core fact. */
export type CoreCallEffectSummaryClaim = Pick<
	CoreCallSummaryClaim,
	"targets" | "effects"
>;

/** Value-only claim attached to an instruction. */
export type CoreCallValueSummaryClaim = Omit<CoreCallSummaryClaim, "effects">;

export interface CoreSummaryStatistics {
	readonly functions: number;
	readonly callEdges: number;
	readonly components: number;
	readonly cyclicComponents: number;
	/** Transfer evaluations; bounded by edges times dimension height. */
	readonly transfers: number;
	readonly saturatedComponents: number;
}

export interface CoreProgramSummaries {
	summary(functionIndex: number): CoreFunctionSummary | undefined;
	/**
	 * The proven claim for one call site, or undefined when the site is not an
	 * ordinary call with a finite closed target set.
	 */
	callSite(
		functionIndex: number,
		instruction: CoreInstructionId,
	): CoreCallSummaryClaim | undefined;
	readonly functions: ReadonlyArray<CoreFunctionSummary>;
	readonly modules: ReadonlyArray<CoreModuleSummary>;
	readonly targets: CoreCalleeTargetAnalysis;
	/** Opening kinds the closure certificate reported, in certificate order. */
	readonly closureOpenings: ReadonlyArray<string>;
	readonly sourceClosed: boolean;
	readonly statistics: CoreSummaryStatistics;
}

/** How one operand of a call maps onto the callee's frame. */
type ArgumentPosition =
	| { readonly kind: "receiver" }
	| {
			readonly kind: "parameter";
			readonly index: number;
	  };

interface CallSite {
	readonly instruction: CoreInstructionId;
	readonly opcode: string;
	/** Sorted, finite, and closed; an open site is not recorded at all. */
	readonly targets: ReadonlyArray<number>;
	readonly inputs: ReadonlyArray<CoreValueId>;
	readonly result: CoreValueId | undefined;
}

interface ArgumentUse {
	readonly value: CoreValueId;
	readonly site: CallSite;
	readonly position: ArgumentPosition;
}

interface LocalFacts {
	/** Effects of everything except calls whose effects come from a callee. */
	readonly effects: EffectSummary;
	readonly effectSites: ReadonlyArray<CallSite>;
	/** Every named edge, including sites whose effects stay at the baseline. */
	readonly calleeEdges: ReadonlyArray<number>;
	readonly openCallEdge: boolean;
	/** Escape a value already has from uses that need no callee summary. */
	readonly escapeBase: ReadonlyMap<CoreValueId, ValueEscapeFact>;
	/** `value` is at least as escaped as every value it forwards into. */
	readonly escapeForward: ReadonlyMap<CoreValueId, ReadonlyArray<CoreValueId>>;
	readonly escapeArguments: ReadonlyArray<ArgumentUse>;
	/** Values whose uses invalidate a caller-owned exact allocation proof. */
	readonly containmentBase: ReadonlySet<CoreValueId>;
	readonly receiverValues: ReadonlyArray<CoreValueId>;
	/** `arguments[index]`, one exact argument position each. */
	readonly exactArgumentValues: ReadonlyArray<{
		readonly value: CoreValueId;
		readonly index: number;
	}>;
	/** Aggregates covering every argument position from `from` onward. */
	readonly aggregateArgumentValues: ReadonlyArray<{
		readonly value: CoreValueId;
		readonly from: number;
	}>;
	/** Provenance of returned values that needs no callee summary. */
	readonly returnProvenanceBase: ReturnProvenance;
	readonly returnRepresentationBase: ReturnRepresentation;
	/** Returned values produced directly by a resolvable ordinary call. */
	readonly returnedCallSites: ReadonlyArray<CallSite>;
	readonly frameOutlivesCall: boolean;
}

/**
 * Core representations outside the scalar set collapse to `boxed`: they describe
 * a region-local encoding rather than something a call boundary hands back.
 */
function summaryRepresentation(
	representation: CoreRepresentation | undefined,
): ReturnRepresentation {
	switch (representation) {
		case "f64":
			return "f64";
		case "i32":
			return "i32";
		case "boolean":
			return "boolean";
		default:
			return "boxed";
	}
}

interface OutgoingEdge {
	readonly block: number;
	readonly arguments: ReadonlyArray<CoreValueId>;
	/** Handler edges land past the handler's implicit exception parameter. */
	readonly parameterOffset: number;
}

function outgoingEdges(block: CoreBlock): ReadonlyArray<OutgoingEdge> {
	const edges: Array<OutgoingEdge> = [];
	const terminator = block.terminator;
	const add = (edge: {
		readonly block: number;
		readonly arguments: ReadonlyArray<CoreValueId>;
	}): void => {
		edges.push({ block: edge.block, arguments: edge.arguments, parameterOffset: 0 });
	};
	switch (terminator.kind) {
		case "jump":
			add(terminator.edge);
			break;
		case "branch":
			add(terminator.consequent);
			add(terminator.alternate);
			break;
		case "guard":
			add(terminator.success);
			add(terminator.fallback);
			break;
		case "switch":
			for (const { edge } of terminator.cases) add(edge);
			add(terminator.default);
			break;
		default:
			break;
	}
	if (block.handler !== undefined) {
		edges.push({
			block: block.handler.block,
			arguments: block.handler.arguments,
			parameterOffset: 1,
		});
	}
	return edges;
}

/**
 * Where an operand of a call lands in the callee's frame, or undefined when the
 * mapping is not statically known.
 *
 * The spread forms hand over a marshalled array, so no operand maps to a
 * parameter and every one of them is treated as escaping.
 */
function argumentPosition(
	opcode: string,
	position: number,
): ArgumentPosition | undefined {
	if (opcode === "call") {
		return position === 1
			? { kind: "receiver" }
			: position >= 2
				? { kind: "parameter", index: position - 2 }
				: undefined;
	}
	if (opcode === "construct") {
		return position >= 1 ? { kind: "parameter", index: position - 1 } : undefined;
	}
	return undefined;
}

function localReturnProvenance(
	value: CoreValueId,
	definitions: ReadonlyMap<CoreValueId, CoreInstruction>,
	parameterIndices: ReadonlyMap<CoreValueId, number>,
	registry: CoreOpcodeRegistry,
): ReturnProvenance {
	const seen = new Set<CoreValueId>();
	let current = value;
	while (!seen.has(current)) {
		seen.add(current);
		const parameter = parameterIndices.get(current);
		if (parameter !== undefined) return { kind: "parameter", index: parameter };
		const definition = definitions.get(current);
		if (definition === undefined) return RETURN_PROVENANCE_UNKNOWN;
		if (definition.opcode === "move" && definition.inputs.length === 1) {
			current = definition.inputs[0]!;
			continue;
		}
		if (definition.opcode === "loadThis") return { kind: "receiver" };
		if (PRIMITIVE_RESULT_OPCODES.has(definition.opcode)) return { kind: "primitive" };
		if (
			registry.get(definition.opcode)?.allocation !== undefined ||
			FRESH_IDENTITY_OPCODES.has(definition.opcode)
		) {
			return { kind: "fresh" };
		}
		return RETURN_PROVENANCE_UNKNOWN;
	}
	return RETURN_PROVENANCE_UNKNOWN;
}

function summaryObservesOperands(
	instruction: CoreInstruction,
	registry: CoreOpcodeRegistry,
): boolean {
	if (registry.get(instruction.opcode)?.observesOperands === true) return true;
	const operator = instruction.attributes.operator;
	return (
		(instruction.opcode === "binary" && (operator === "===" || operator === "!==")) ||
		(instruction.opcode === "unary" && operator === "typeof")
	);
}

/**
 * Collect everything about one function that does not depend on a callee.
 *
 * Effects come from `coreInstructionEffects`, so a refinement another pass
 * already proved — a contained own-data-cell access, for instance — narrows this
 * summary too, and a summary is never more pessimistic than the graph it
 * describes.
 */
function collectLocalFacts(
	fn: CoreFunction,
	targets: CoreCalleeTargetAnalysis,
	registry: CoreOpcodeRegistry,
): LocalFacts {
	let effects = NO_EFFECT_SUMMARY;
	const effectSites: Array<CallSite> = [];
	const calleeEdges = new Set<number>();
	let openCallEdge = false;
	const escapeBase = new Map<CoreValueId, ValueEscapeFact>();
	const escapeForward = new Map<CoreValueId, Array<CoreValueId>>();
	const escapeArguments: Array<ArgumentUse> = [];
	const containmentBase = new Set<CoreValueId>();
	const receiverValues: Array<CoreValueId> = [];
	const exactArgumentValues: Array<{
		readonly value: CoreValueId;
		readonly index: number;
	}> = [];
	const aggregateArgumentValues: Array<{
		readonly value: CoreValueId;
		readonly from: number;
	}> = [];
	const returnedCallSites: Array<CallSite> = [];
	let returnProvenanceBase = RETURN_PROVENANCE_NONE;
	let returnRepresentationBase: ReturnRepresentation = "none";
	const definitions = new Map<CoreValueId, CoreInstruction>();
	const callSiteByResult = new Map<CoreValueId, CallSite>();
	const representations = new Map<CoreValueId, CoreRepresentation>(
		fn.values.map(({ id, representation }) => [id, representation] as const),
	);
	const parameterIndices = new Map<CoreValueId, number>(
		fn.parameters.map((value, index) => [value, index] as const),
	);

	const raiseBase = (value: CoreValueId, level: ValueEscapeFact): void => {
		const current = escapeBase.get(value);
		escapeBase.set(
			value,
			current === undefined ? level : joinValueEscape(current, level),
		);
	};
	const addForward = (from: CoreValueId, to: CoreValueId): void => {
		const existing = escapeForward.get(from);
		if (existing === undefined) escapeForward.set(from, [to]);
		else existing.push(to);
	};
	const breakContainment = (value: CoreValueId): void => {
		containmentBase.add(value);
	};

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			for (const output of instruction.outputs) definitions.set(output, instruction);
		}
	}

	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			const producer = ARGUMENT_PRODUCERS[instruction.opcode];
			if (producer !== undefined) {
				const declared =
					producer.positionAttribute === undefined
						? 0
						: instruction.attributes[producer.positionAttribute];
				const position =
					typeof declared === "number" && Number.isSafeInteger(declared) && declared >= 0
						? declared
						: undefined;
				for (const [output, value] of instruction.outputs.entries()) {
					if (output === 0 && producer.exact === true && position !== undefined) {
						exactArgumentValues.push({ value, index: position });
						continue;
					}
					// A secondary result is the materialized arguments object, which
					// aggregates the list from its first position regardless of the index
					// the primary result named.
					aggregateArgumentValues.push({
						value,
						from: output === 0 ? (position ?? 0) : 0,
					});
				}
			}
			if (instruction.opcode === "loadThis") {
				for (const output of instruction.outputs) receiverValues.push(output);
			}

			const transfer = callTransfer(instruction, registry);
			const isCall = transfer !== undefined && transfer.result !== "unmodeled";
			const isEdgeOnlyCall = transfer?.result === "unmodeled";
			let site: CallSite | undefined;
			if (transfer !== undefined) {
				const callee = instruction.inputs[transfer.calleeOperand];
				const resolved =
					callee === undefined ? undefined : targets.targets(fn.functionIndex, callee);
				if (
					resolved !== undefined &&
					!coreCalleeTargetsAreOpen(resolved) &&
					resolved.functions.length > 0
				) {
					for (const target of resolved.functions) calleeEdges.add(target);
					if (isEdgeOnlyCall) {
						effects = joinEffectSummaries(
							effects,
							coreInstructionEffects(instruction, registry),
						);
					} else {
						site = {
							instruction: instruction.id,
							opcode: instruction.opcode,
							targets: resolved.functions,
							inputs: instruction.inputs,
							result: instruction.outputs[0],
						};
						if (instruction.opcode === "call") effectSites.push(site);
						else
							effects = joinEffectSummaries(
								effects,
								coreInstructionEffects(instruction, registry),
							);
						if (site.result !== undefined) callSiteByResult.set(site.result, site);
					}
				} else {
					openCallEdge = true;
					effects = joinEffectSummaries(
						effects,
						coreInstructionEffects(instruction, registry),
					);
				}
			} else {
				effects = joinEffectSummaries(
					effects,
					coreInstructionEffects(instruction, registry),
				);
				// Any other instruction that enters user code is a call edge this
				// analysis cannot name: a getter, a setter, a coercion hook, a builtin
				// that takes a callback. The edge set is only closed once no such
				// instruction is left, so the flag is derived from declared effects
				// rather than from a list of opcodes that could fall behind them.
				if (coreInstructionEffects(instruction, registry).callsUserCode) {
					openCallEdge = true;
				}
			}

			if (instruction.opcode === "move" && instruction.outputs.length === 1) {
				addForward(instruction.inputs[0]!, instruction.outputs[0]!);
				continue;
			}
			// An operand the registry declares as merely observed is not retained.
			if (summaryObservesOperands(instruction, registry)) continue;
			for (const [position, input] of instruction.inputs.entries()) {
				if (isCall && position === transfer.calleeOperand) {
					// Being invoked is not being kept: the reference lives on the stack for
					// the duration of the call and nothing here stores it.
					raiseBase(input, "invoked");
					breakContainment(input);
					continue;
				}
				const mapped =
					site === undefined ? undefined : argumentPosition(instruction.opcode, position);
				if (mapped !== undefined) {
					escapeArguments.push({ value: input, site: site!, position: mapped });
					continue;
				}
				raiseBase(input, "retained");
				breakContainment(input);
			}
		}

		const terminator = block.terminator;
		if (terminator.kind === "return") {
			raiseBase(terminator.value, "returned");
			const site = callSiteByResult.get(terminator.value);
			if (site?.opcode === "call") {
				returnedCallSites.push(site);
			} else {
				returnProvenanceBase = joinReturnProvenance(
					returnProvenanceBase,
					localReturnProvenance(
						terminator.value,
						definitions,
						parameterIndices,
						registry,
					),
				);
			}
			// An ordinary call's Core output starts boxed because that is the runtime
			// call ABI, not because the completed value has unknown machine shape. Defer
			// an exact returned call to the callee summaries below instead of poisoning
			// their scalar result with that transport representation. Construct and other
			// transfer results stay local: a constructor's returned primitive is not the
			// representation of the object produced by [[Construct]].
			if (site?.opcode !== "call") {
				returnRepresentationBase = joinReturnRepresentation(
					returnRepresentationBase,
					summaryRepresentation(representations.get(terminator.value)),
				);
			}
		} else if (terminator.kind === "throw") {
			// A thrown reference leaves this frame through the handler chain.
			raiseBase(terminator.value, "retained");
			breakContainment(terminator.value);
			effects = joinEffectSummaries(effects, { ...NO_EFFECT_SUMMARY, mayThrow: true });
		}
		for (const edge of outgoingEdges(block)) {
			const target = fn.blocks[edge.block];
			if (target === undefined) continue;
			for (const [index, argument] of edge.arguments.entries()) {
				const parameter = target.parameters[index + edge.parameterOffset];
				if (parameter !== undefined) addForward(argument, parameter.value);
			}
		}
	}

	return {
		effects,
		effectSites,
		calleeEdges: [...calleeEdges].sort((left, right) => left - right),
		openCallEdge,
		escapeBase,
		escapeForward,
		escapeArguments,
		containmentBase,
		receiverValues,
		exactArgumentValues,
		aggregateArgumentValues,
		returnProvenanceBase,
		returnRepresentationBase,
		returnedCallSites,
		// A heap-allocated activation keeps everything the caller handed it alive
		// past the call, and mapped arguments alias the formals through a live object.
		frameOutlivesCall:
			fn.isGenerator || fn.isAsync || fn.metadata.mappedArguments === true,
	};
}

interface MutableSummary {
	readonly effects: EffectSummary;
	readonly parameterEscape: ReadonlyArray<ValueEscapeFact>;
	readonly restParameterEscape: ValueEscapeFact;
	readonly receiverEscape: ValueEscapeFact;
	readonly parameterContainment: ReadonlyArray<ValueContainmentFact>;
	readonly restParameterContainment: ValueContainmentFact;
	readonly receiverContainment: ValueContainmentFact;
	readonly returnProvenance: ReturnProvenance;
	readonly returnRepresentation: ReturnRepresentation;
}

function summaryKey(summary: MutableSummary): string {
	return [
		effectSummaryKey(summary.effects),
		summary.parameterEscape.join(","),
		summary.restParameterEscape,
		summary.receiverEscape,
		summary.parameterContainment.join(","),
		summary.restParameterContainment,
		summary.receiverContainment,
		returnProvenanceKey(summary.returnProvenance),
		summary.returnRepresentation,
	].join("|");
}

function bottomSummary(parameterCount: number): MutableSummary {
	return {
		effects: NO_EFFECT_SUMMARY,
		parameterEscape: new Array<ValueEscapeFact>(parameterCount).fill("none"),
		restParameterEscape: "none",
		receiverEscape: "none",
		parameterContainment: new Array<ValueContainmentFact>(parameterCount).fill(
			"preserved",
		),
		restParameterContainment: "preserved",
		receiverContainment: "preserved",
		returnProvenance: RETURN_PROVENANCE_NONE,
		returnRepresentation: "none",
	};
}

function saturatedSummary(parameterCount: number): MutableSummary {
	return {
		effects: EVERY_EFFECT_SUMMARY,
		parameterEscape: new Array<ValueEscapeFact>(parameterCount).fill("retained"),
		restParameterEscape: "retained",
		receiverEscape: "retained",
		parameterContainment: new Array<ValueContainmentFact>(parameterCount).fill("unknown"),
		restParameterContainment: "unknown",
		receiverContainment: "unknown",
		returnProvenance: RETURN_PROVENANCE_UNKNOWN,
		returnRepresentation: "boxed",
	};
}

function calleeEscape(
	callee: MutableSummary | undefined,
	position: ArgumentPosition,
): ValueEscapeFact {
	if (callee === undefined) return "retained";
	return position.kind === "receiver"
		? callee.receiverEscape
		: (callee.parameterEscape[position.index] ?? callee.restParameterEscape);
}

function calleeContainment(
	callee: MutableSummary | undefined,
	position: ArgumentPosition,
): ValueContainmentFact {
	if (callee === undefined) return "unknown";
	return position.kind === "receiver"
		? callee.receiverContainment
		: (callee.parameterContainment[position.index] ?? callee.restParameterContainment);
}

/**
 * Solve one function's dimensions from the current state of its callees.
 *
 * The escape part is a local fixed point: a value is at least as escaped as
 * everything it forwards into, and an argument is at least as escaped as the
 * callee's matching parameter — plus, when the callee can hand it back, as
 * escaped as the call's own result, because the caller may then retain it.
 */
function transferSummary(
	fn: CoreFunction,
	local: LocalFacts,
	state: ReadonlyArray<MutableSummary | undefined>,
): MutableSummary {
	let effects = local.effects;
	for (const site of local.effectSites) {
		effects = joinEffectSummaries(effects, joinedCalleeEffects(site, state));
	}

	const levels = new Map<CoreValueId, ValueEscapeFact>(local.escapeBase);
	const raise = (value: CoreValueId, level: ValueEscapeFact): boolean => {
		const current = levels.get(value) ?? "none";
		const next = joinValueEscape(current, level);
		if (next === current) return false;
		levels.set(value, next);
		return true;
	};
	// Sources of each forwarding edge, so a raised level flows back to whatever
	// can still reach it.
	const sourcesOf = new Map<CoreValueId, Array<CoreValueId>>();
	const addSource = (target: CoreValueId, source: CoreValueId): void => {
		const existing = sourcesOf.get(target);
		if (existing === undefined) sourcesOf.set(target, [source]);
		else existing.push(source);
	};
	for (const [from, targets] of local.escapeForward) {
		for (const to of targets) addSource(to, from);
	}
	for (const use of local.escapeArguments) {
		let level: ValueEscapeFact = "none";
		for (const target of use.site.targets) {
			level = joinValueEscape(level, calleeEscape(state[target], use.position));
		}
		raise(use.value, level);
		if (use.site.result !== undefined && (level === "returned" || level === "retained")) {
			addSource(use.site.result, use.value);
		}
	}
	const pending = [...levels.keys()];
	while (pending.length > 0) {
		const value = pending.pop()!;
		const level = levels.get(value) ?? "none";
		for (const source of sourcesOf.get(value) ?? []) {
			if (raise(source, level)) pending.push(source);
		}
	}

	const containmentUnknown = new Set(local.containmentBase);
	for (const use of local.escapeArguments) {
		let containment: ValueContainmentFact = "preserved";
		for (const target of use.site.targets) {
			containment = joinValueContainment(
				containment,
				calleeContainment(state[target], use.position),
			);
		}
		if (containment === "unknown") containmentUnknown.add(use.value);
	}
	const pendingContainment = [...containmentUnknown];
	while (pendingContainment.length > 0) {
		const value = pendingContainment.pop()!;
		for (const source of sourcesOf.get(value) ?? []) {
			if (containmentUnknown.has(source)) continue;
			containmentUnknown.add(source);
			pendingContainment.push(source);
		}
	}

	const escapeOf = (value: CoreValueId): ValueEscapeFact =>
		local.frameOutlivesCall ? "retained" : (levels.get(value) ?? "none");
	const containmentOf = (value: CoreValueId): ValueContainmentFact =>
		local.frameOutlivesCall || containmentUnknown.has(value) ? "unknown" : "preserved";
	const arity = fn.parameters.length;
	const parameterEscape = fn.parameters.map((value) => escapeOf(value));
	const parameterContainment = fn.parameters.map((value) => containmentOf(value));
	let restParameterEscape: ValueEscapeFact = local.frameOutlivesCall
		? "retained"
		: "none";
	let restParameterContainment: ValueContainmentFact = local.frameOutlivesCall
		? "unknown"
		: "preserved";

	// Every aggregate covers a suffix of the argument positions, so one bucketed
	// scan followed by a prefix join attributes all of them to all formals in
	// O(arity + producers) — no per-aggregate walk over the formals.
	const aggregateEscape = new Array<ValueEscapeFact>(arity).fill("none");
	const aggregateContainment = new Array<ValueContainmentFact>(arity).fill("preserved");
	for (const { value, from } of local.aggregateArgumentValues) {
		// An aggregate reaches past the declared formals by construction, so it also
		// covers the rest bucket whatever its first position is.
		restParameterEscape = joinValueEscape(restParameterEscape, escapeOf(value));
		restParameterContainment = joinValueContainment(
			restParameterContainment,
			containmentOf(value),
		);
		if (from >= arity) continue;
		aggregateEscape[from] = joinValueEscape(aggregateEscape[from]!, escapeOf(value));
		aggregateContainment[from] = joinValueContainment(
			aggregateContainment[from]!,
			containmentOf(value),
		);
	}
	for (let index = 0; index < arity; index += 1) {
		if (index > 0) {
			aggregateEscape[index] = joinValueEscape(
				aggregateEscape[index]!,
				aggregateEscape[index - 1]!,
			);
			aggregateContainment[index] = joinValueContainment(
				aggregateContainment[index]!,
				aggregateContainment[index - 1]!,
			);
		}
		parameterEscape[index] = joinValueEscape(
			parameterEscape[index]!,
			aggregateEscape[index]!,
		);
		parameterContainment[index] = joinValueContainment(
			parameterContainment[index]!,
			aggregateContainment[index]!,
		);
	}
	for (const { value, index } of local.exactArgumentValues) {
		if (index >= arity) {
			restParameterEscape = joinValueEscape(restParameterEscape, escapeOf(value));
			restParameterContainment = joinValueContainment(
				restParameterContainment,
				containmentOf(value),
			);
			continue;
		}
		parameterEscape[index] = joinValueEscape(parameterEscape[index]!, escapeOf(value));
		parameterContainment[index] = joinValueContainment(
			parameterContainment[index]!,
			containmentOf(value),
		);
	}

	let receiverEscape: ValueEscapeFact = local.frameOutlivesCall ? "retained" : "none";
	for (const value of local.receiverValues) {
		receiverEscape = joinValueEscape(receiverEscape, escapeOf(value));
	}
	let receiverContainment: ValueContainmentFact = local.frameOutlivesCall
		? "unknown"
		: "preserved";
	for (const value of local.receiverValues) {
		receiverContainment = joinValueContainment(receiverContainment, containmentOf(value));
	}

	let returnProvenance = local.returnProvenanceBase;
	let returnRepresentation = local.returnRepresentationBase;
	for (const site of local.returnedCallSites) {
		for (const target of site.targets) {
			const callee = state[target];
			// A callee's `parameter` or `receiver` names the callee's own frame, and
			// substituting the argument is not modelled, so it crosses as unknown.
			returnProvenance = joinReturnProvenance(
				returnProvenance,
				callee === undefined ||
					callee.returnProvenance.kind === "parameter" ||
					callee.returnProvenance.kind === "receiver"
					? RETURN_PROVENANCE_UNKNOWN
					: callee.returnProvenance,
			);
			returnRepresentation = joinReturnRepresentation(
				returnRepresentation,
				callee?.returnRepresentation ?? "boxed",
			);
		}
	}

	return {
		effects,
		parameterEscape,
		restParameterEscape,
		receiverEscape,
		parameterContainment,
		restParameterContainment,
		receiverContainment,
		returnProvenance: fn.isGenerator || fn.isAsync ? { kind: "fresh" } : returnProvenance,
		// The result of calling a generator or async function is the generator or
		// promise object, never the value its body returns.
		returnRepresentation: fn.isGenerator || fn.isAsync ? "boxed" : returnRepresentation,
	};
}

function joinedCalleeEffects(
	site: CallSite,
	state: ReadonlyArray<MutableSummary | undefined>,
): EffectSummary {
	let effects = CORE_CALL_FRAME_EFFECTS;
	for (const target of site.targets) {
		effects = joinEffectSummaries(
			effects,
			state[target]?.effects ?? EVERY_EFFECT_SUMMARY,
		);
	}
	return effects;
}

function joinedCallEscape(
	site: CallSite,
	state: ReadonlyArray<MutableSummary | undefined>,
	position: ArgumentPosition,
): ValueEscapeFact {
	let escape: ValueEscapeFact = "none";
	for (const target of site.targets) {
		escape = joinValueEscape(escape, calleeEscape(state[target], position));
	}
	return escape;
}

function joinedCallContainment(
	site: CallSite,
	state: ReadonlyArray<MutableSummary | undefined>,
	position: ArgumentPosition,
): ValueContainmentFact {
	let containment: ValueContainmentFact = "preserved";
	for (const target of site.targets) {
		containment = joinValueContainment(
			containment,
			calleeContainment(state[target], position),
		);
	}
	return containment;
}

function joinedCallProvenance(
	site: CallSite,
	state: ReadonlyArray<MutableSummary | undefined>,
): ReturnProvenance {
	let provenance = RETURN_PROVENANCE_NONE;
	for (const target of site.targets) {
		provenance = joinReturnProvenance(
			provenance,
			state[target]?.returnProvenance ?? RETURN_PROVENANCE_UNKNOWN,
		);
	}
	return provenance;
}

function joinedCallRepresentation(
	site: CallSite,
	state: ReadonlyArray<MutableSummary | undefined>,
): ReturnRepresentation {
	let representation: ReturnRepresentation = "none";
	for (const target of site.targets) {
		representation = joinReturnRepresentation(
			representation,
			state[target]?.returnRepresentation ?? "boxed",
		);
	}
	return representation;
}

interface Condensation {
	readonly componentOf: Int32Array;
	readonly components: ReadonlyArray<ReadonlyArray<number>>;
	/** Every callee component precedes each of its caller components. */
	readonly order: ReadonlyArray<number>;
	readonly cyclic: ReadonlyArray<boolean>;
}

/**
 * Iterative Kosaraju over the call graph, then a ready-queue topological order of
 * the condensation. Both walks use explicit stacks.
 */
function condenseCallGraph(
	callees: ReadonlyArray<ReadonlyArray<number>>,
	callers: ReadonlyArray<ReadonlyArray<number>>,
): Condensation {
	const count = callees.length;
	const visited = new Uint8Array(count);
	const postorder: Array<number> = [];
	for (let start = 0; start < count; start += 1) {
		if (visited[start] !== 0) continue;
		visited[start] = 1;
		const stack: Array<{ readonly node: number; next: number }> = [
			{ node: start, next: 0 },
		];
		while (stack.length > 0) {
			const frame = stack[stack.length - 1]!;
			const outgoing = callees[frame.node]!;
			if (frame.next < outgoing.length) {
				const next = outgoing[frame.next++]!;
				if (next < count && visited[next] === 0) {
					visited[next] = 1;
					stack.push({ node: next, next: 0 });
				}
				continue;
			}
			postorder.push(frame.node);
			stack.pop();
		}
	}

	const componentOf = new Int32Array(count).fill(-1);
	const components: Array<Array<number>> = [];
	for (let index = postorder.length - 1; index >= 0; index -= 1) {
		const start = postorder[index]!;
		if (componentOf[start]! >= 0) continue;
		const component = components.length;
		const members: Array<number> = [];
		components.push(members);
		componentOf[start] = component;
		const pending = [start];
		while (pending.length > 0) {
			const node = pending.pop()!;
			members.push(node);
			for (const caller of callers[node]!) {
				if (componentOf[caller]! >= 0) continue;
				componentOf[caller] = component;
				pending.push(caller);
			}
		}
	}

	const dependencies = components.map(() => new Set<number>());
	const cyclic = components.map((members) => members.length > 1);
	for (let node = 0; node < count; node += 1) {
		const component = componentOf[node]!;
		for (const callee of callees[node]!) {
			if (callee >= count) continue;
			const calleeComponent = componentOf[callee]!;
			if (calleeComponent === component) {
				// A self edge is what makes a one-member component recursive.
				if (callee === node) cyclic[component] = true;
				continue;
			}
			dependencies[component]!.add(calleeComponent);
		}
	}
	const users = components.map(() => new Array<number>());
	for (const [component, calleeComponents] of dependencies.entries()) {
		for (const callee of calleeComponents) users[callee]!.push(component);
	}
	const remaining = Int32Array.from(dependencies.map(({ size }) => size));
	const ready: Array<number> = [];
	for (let component = 0; component < components.length; component += 1) {
		if (remaining[component] === 0) ready.push(component);
	}
	const order: Array<number> = [];
	while (ready.length > 0) {
		const component = ready.pop()!;
		order.push(component);
		for (const user of users[component]!) {
			remaining[user]! -= 1;
			if (remaining[user] === 0) ready.push(user);
		}
	}
	return { componentOf, components, order, cyclic };
}

/** Digest binding a recorded claim to its contents; never parsed back. */
export function coreCallSummaryDigest(claim: CoreCallEffectSummaryClaim): string {
	return `callee-effects:v1:[${claim.targets.join(",")}]:${effectSummaryKey(claim.effects)}`;
}

/** Digest for value facts, independent of effect precision. */
export function coreCallValueSummaryDigest(claim: CoreCallValueSummaryClaim): string {
	return [
		"callee-values:v2",
		`[${claim.targets.join(",")}]`,
		claim.receiverEscape,
		`[${claim.argumentEscape.join(",")}]`,
		claim.receiverContainment,
		`[${claim.argumentContainment.join(",")}]`,
		returnProvenanceKey(claim.returnProvenance),
		claim.returnRepresentation,
	].join(":");
}

/** Plain Core attribute carrying the exact value claim the verifier re-proves. */
export function coreCallSummaryAttribute(
	claim: CoreCallSummaryClaim,
): CoreAttributeObject {
	return {
		digest: coreCallValueSummaryDigest(claim),
		targets: [...claim.targets],
		receiverEscape: claim.receiverEscape,
		argumentEscape: [...claim.argumentEscape],
		receiverContainment: claim.receiverContainment,
		argumentContainment: [...claim.argumentContainment],
		returnProvenance: { ...claim.returnProvenance },
		returnRepresentation: claim.returnRepresentation,
	};
}

/** The Core result representation a call claim licenses, or boxed by default. */
export function coreCallResultRepresentation(
	claim: Pick<CoreCallSummaryClaim, "returnRepresentation">,
): CoreRepresentation {
	return claim.returnRepresentation === "f64" || claim.returnRepresentation === "boolean"
		? claim.returnRepresentation
		: "boxed";
}

/**
 * The narrowing a recorded claim licenses on one opcode's baseline, or undefined
 * when the claim proves nothing the baseline does not already say.
 *
 * Each flag and each direction is decided on its own:
 *
 * - `reads` and `writes` may only lose a baseline domain when the callee provably
 *   touches nothing in that direction. An ordinary call declares only the `host`
 *   domain, so a callee that writes a global slot cannot be described more
 *   narrowly than the baseline and keeps it; a refinement may never add a domain.
 * - `callsUserCode` is consumed as the barrier for every cell an analysis cannot
 *   attribute to a base, so it may only be dropped once the callee provably
 *   writes nothing. Dropping it while the callee writes memory the refinement
 *   cannot name would hide exactly those writes.
 * - `mayThrow`, `maySuspend`, and `mayGc` stay at the baseline. Stack exhaustion
 *   makes every call a throwing operation regardless of its callee, and
 *   collection and suspension points are lowering properties this slice does not
 *   prove absent.
 */
export function deriveCoreCallEffectRefinement(
	baseline: EffectSummary,
	claim: CoreCallEffectSummaryClaim,
): EffectSummary | undefined {
	if (claim.effects.callsUserCode) return undefined;
	const refined: EffectSummary = {
		reads: claim.effects.reads.length === 0 ? [] : normalizeEffectDomains(baseline.reads),
		writes:
			claim.effects.writes.length === 0 ? [] : normalizeEffectDomains(baseline.writes),
		mayThrow: baseline.mayThrow,
		maySuspend: baseline.maySuspend,
		mayGc: baseline.mayGc,
		callsUserCode: claim.effects.writes.length === 0 ? false : baseline.callsUserCode,
	};
	return effectSummariesEqual(refined, baseline) ? undefined : refined;
}

/**
 * Whether a recorded claim still covers what the current graph proves.
 *
 * The target set must match exactly — a site that no longer resolves to the same
 * closed set is a different site — while the effects may be weaker than reality.
 * That asymmetry keeps a sound graph verifiable when a later pass makes a callee
 * more precise, and still rejects a claim whose callee has grown new effects.
 */
export function coreCallSummaryClaimHolds(
	claim: CoreCallEffectSummaryClaim,
	current: CoreCallSummaryClaim,
): boolean {
	return (
		claim.targets.length === current.targets.length &&
		claim.targets.every((target, index) => target === current.targets[index]) &&
		effectSummaryCovers(claim.effects, current.effects)
	);
}

function moduleEvaluationPaths(
	context: CoreCompilationContext | undefined,
): ReadonlySet<string> {
	return new Set(context?.data.moduleEvaluationOrder ?? []);
}

/**
 * Function identities that reach a sink the target lattice does not follow.
 *
 * A store into a named global or captured slot, a callee operand, a name
 * assignment, and a forwarding move or block argument are edges the lattice
 * already models, so they publish nothing new. Anything else — a property store,
 * an argument, a returned or thrown closure — hands the reference somewhere this
 * analysis cannot name, so the function must be treated as independently
 * enterable.
 */
function collectPublishedFunctions(
	program: CoreProgram,
	registry: CoreOpcodeRegistry,
	targets: CoreCalleeTargetAnalysis,
): ReadonlySet<number> {
	const published = new Set<number>();
	const publish = (functionIndex: number, value: CoreValueId): void => {
		const reaching = targets.targets(functionIndex, value);
		if (reaching.anyScript) {
			for (const fn of program.functions) published.add(fn.functionIndex);
			return;
		}
		for (const target of reaching.functions) published.add(target);
	};
	for (const fn of program.functions) {
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const descriptor = registry.get(instruction.opcode);
				if (descriptor?.observesOperands === true) continue;
				// A super construction's parent operand is deliberately not exempt: its
				// result becomes `this` and this analysis does not model where that goes,
				// so the parent stays published.
				const invoked =
					descriptor?.callTransfer !== undefined &&
					descriptor.callTransfer.result !== "unmodeled"
						? descriptor.callTransfer.calleeOperand
						: undefined;
				const exactCallback = instruction.attributes.directCallbackFunctionIndex;
				const callbackOperand =
					instruction.opcode === "call" && typeof exactCallback === "number"
						? instruction.inputs[2]
						: undefined;
				for (const [position, input] of instruction.inputs.entries()) {
					if (position === invoked) continue;
					// A locked builtin callback with a certified singleton target is not
					// published merely because the call ABI carries its identity. The known
					// Array operation invokes it synchronously through the modeled callback
					// edge; no unknown sink receives it. Keeping this edge closed is what lets
					// value flow retain exact callback-index and later element-cell facts.
					if (
						position === 2 &&
						input === callbackOperand &&
						coreCalleeTargetsClosedFunction(targets.targets(fn.functionIndex, input)) ===
							exactCallback
					) {
						continue;
					}
					if (
						instruction.opcode === "storeGlobal" ||
						instruction.opcode === "storeCaptured"
					)
						continue;
					if (instruction.opcode === "setFunctionName" && position === 0) continue;
					publish(fn.functionIndex, input);
				}
			}
			if (block.terminator.kind === "return" || block.terminator.kind === "throw") {
				publish(fn.functionIndex, block.terminator.value);
			}
		}
	}
	return published;
}

/**
 * Functions the world outside this graph can enter, and why.
 *
 * The closure certificate is the authority: without a graph-derived proof that
 * the compiler saw the whole program, every function is a root and every
 * reachability claim must say so. A certificate alone is never enough either —
 * the host installs its exports into global slots this graph does not write, and
 * an identity that reaches an unnameable sink is reachable through that sink.
 */
function collectRootReasons(
	program: CoreProgram,
	targets: CoreCalleeTargetAnalysis,
	published: ReadonlySet<number>,
	context: CoreCompilationContext | undefined,
): ReadonlyMap<number, ReadonlyArray<SummaryRootReason>> {
	const reasons = new Map<number, Set<SummaryRootReason>>();
	const add = (functionIndex: number, reason: SummaryRootReason): void => {
		const existing = reasons.get(functionIndex);
		if (existing === undefined) reasons.set(functionIndex, new Set([reason]));
		else existing.add(reason);
	};
	const sourceClosed = context?.facts.closure.sourceClosure.kind === "known";
	for (const fn of program.functions) {
		if (!sourceClosed) add(fn.functionIndex, "open-world");
		if (published.has(fn.functionIndex)) add(fn.functionIndex, "published-identity");
	}
	// The image's eager entry. A multi-module program merges every module top level
	// into it, so there is no per-module init to enumerate.
	const entry = program.functions[0];
	if (entry !== undefined) add(entry.functionIndex, "program-entry");
	for (const index of context?.data.cjsModuleFunctionIndices ?? []) {
		add(index, "commonjs-module");
	}
	for (const candidate of context?.data.hostInstallCandidates ?? []) {
		for (const { slot } of candidate.exports) {
			const installed = targets.globalSlot(slot);
			if (installed.anyScript) {
				for (const fn of program.functions) add(fn.functionIndex, "host-install");
				continue;
			}
			for (const target of installed.functions) add(target, "host-install");
		}
	}
	return new Map(
		[...reasons].map(([index, set]) => [index, normalizeRootReasons(set)] as const),
	);
}

/** Solve every dimension for one program. */
export function analyzeCoreProgramSummaries(
	program: CoreProgram,
	registry: CoreOpcodeRegistry = coreOpcodeRegistry,
	context?: CoreCompilationContext,
): CoreProgramSummaries {
	const targets = analyzeCoreCalleeTargets(program, registry, context);
	const count = program.functions.length;
	const byIndex = new Array<CoreFunction | undefined>(count);
	for (const fn of program.functions) byIndex[fn.functionIndex] = fn;
	const local = new Array<LocalFacts | undefined>(count);
	const callees = new Array<ReadonlyArray<number>>(count).fill([]);
	const callers: Array<Array<number>> = Array.from({ length: count }, () => []);
	let callEdges = 0;
	for (const fn of program.functions) {
		const facts = collectLocalFacts(fn, targets, registry);
		local[fn.functionIndex] = facts;
		const reachable = facts.calleeEdges.filter((target) => target < count);
		callees[fn.functionIndex] = reachable;
		callEdges += reachable.length;
		for (const target of reachable) callers[target]!.push(fn.functionIndex);
	}

	const condensation = condenseCallGraph(callees, callers);
	const state = new Array<MutableSummary | undefined>(count);
	let transfers = 0;
	let saturatedComponents = 0;
	for (const component of condensation.order) {
		const members = condensation.components[component]!;
		const solve = (node: number): MutableSummary => {
			const fn = byIndex[node];
			const facts = local[node];
			transfers += 1;
			return fn === undefined || facts === undefined
				? saturatedSummary(0)
				: transferSummary(fn, facts, state);
		};
		if (!condensation.cyclic[component]) {
			const node = members[0]!;
			state[node] = solve(node);
			continue;
		}
		for (const node of members) {
			state[node] = bottomSummary(byIndex[node]?.parameters.length ?? 0);
		}
		const inComponent = new Set(members);
		const budget = CORE_SUMMARY_COMPONENT_ITERATION_LIMIT * members.length;
		let queue = [...members];
		let spent = 0;
		while (queue.length > 0) {
			if (spent > budget) {
				for (const node of members) {
					state[node] = saturatedSummary(byIndex[node]?.parameters.length ?? 0);
				}
				saturatedComponents += 1;
				break;
			}
			const next: Array<number> = [];
			for (const node of queue) {
				spent += 1;
				const candidate = solve(node);
				if (summaryKey(candidate) === summaryKey(state[node]!)) continue;
				state[node] = candidate;
				for (const caller of callers[node]!) {
					if (inComponent.has(caller) && !next.includes(caller)) next.push(caller);
				}
			}
			queue = next;
		}
	}

	const published = collectPublishedFunctions(program, registry, targets);
	const rootReasons = collectRootReasons(program, targets, published, context);
	const summaries = program.functions.map((fn): CoreFunctionSummary => {
		const solved = state[fn.functionIndex] ?? saturatedSummary(fn.parameters.length);
		const reasons = rootReasons.get(fn.functionIndex) ?? [];
		return {
			functionIndex: fn.functionIndex,
			sourcePath: fn.metadata.sourcePath,
			effects: solved.effects,
			callees: callees[fn.functionIndex] ?? [],
			openCallEdge: local[fn.functionIndex]?.openCallEdge ?? true,
			rootReasons: reasons,
			externallyReachable: reasons.length > 0,
			parameterEscape: solved.parameterEscape,
			restParameterEscape: solved.restParameterEscape,
			receiverEscape: solved.receiverEscape,
			parameterContainment: solved.parameterContainment,
			restParameterContainment: solved.restParameterContainment,
			receiverContainment: solved.receiverContainment,
			returnProvenance: solved.returnProvenance,
			returnRepresentation: solved.returnRepresentation,
		};
	});

	const evaluated = moduleEvaluationPaths(context);
	const modules = [...new Set(summaries.map(({ sourcePath }) => sourcePath))]
		.sort()
		.map((sourcePath): CoreModuleSummary => {
			const members = summaries.filter((summary) => summary.sourcePath === sourcePath);
			let effects = NO_EFFECT_SUMMARY;
			for (const member of members)
				effects = joinEffectSummaries(effects, member.effects);
			return {
				sourcePath,
				effects,
				functions: members.map(({ functionIndex }) => functionIndex),
				externallyReachable: members.some(
					({ externallyReachable }) => externallyReachable,
				),
				evaluated: evaluated.has(sourcePath),
			};
		});

	const claims = new Map<string, CoreCallSummaryClaim>();
	for (const fn of program.functions) {
		for (const site of local[fn.functionIndex]?.effectSites ?? []) {
			claims.set(`${fn.functionIndex}\0${site.instruction}`, {
				targets: site.targets,
				effects: joinedCalleeEffects(site, state),
				receiverEscape: joinedCallEscape(site, state, { kind: "receiver" }),
				argumentEscape: site.inputs
					.slice(2)
					.map((_input, index) =>
						joinedCallEscape(site, state, { kind: "parameter", index }),
					),
				receiverContainment: joinedCallContainment(site, state, {
					kind: "receiver",
				}),
				argumentContainment: site.inputs
					.slice(2)
					.map((_input, index) =>
						joinedCallContainment(site, state, { kind: "parameter", index }),
					),
				returnProvenance: joinedCallProvenance(site, state),
				returnRepresentation: joinedCallRepresentation(site, state),
			});
		}
	}
	const byFunctionIndex = new Map(
		summaries.map((summary) => [summary.functionIndex, summary] as const),
	);
	return {
		summary: (functionIndex) => byFunctionIndex.get(functionIndex),
		callSite: (functionIndex, instruction) =>
			claims.get(`${functionIndex}\0${instruction}`),
		functions: summaries,
		modules,
		targets,
		closureOpenings: (context?.facts.closure.openings ?? []).map(({ kind }) => kind),
		sourceClosed: context?.facts.closure.sourceClosure.kind === "known",
		statistics: {
			functions: count,
			callEdges,
			components: condensation.components.length,
			cyclicComponents: condensation.cyclic.filter(Boolean).length,
			transfers,
			saturatedComponents,
		},
	};
}

/** Fact-system projection of the Core summaries, keyed by stable summary ids. */
export function coreFunctionEffectSummaries(
	summaries: CoreProgramSummaries,
): ReadonlyMap<string, FunctionEffectSummary> {
	const pathOf = new Map(
		summaries.functions.map(
			({ functionIndex, sourcePath }) => [functionIndex, sourcePath] as const,
		),
	);
	const entries = summaries.functions.map(
		(summary): readonly [string, FunctionEffectSummary] => {
			const id = functionSummaryId(summary.sourcePath, summary.functionIndex);
			return [
				id,
				{
					id,
					functionIndex: summary.functionIndex,
					module: moduleSummaryId(summary.sourcePath),
					effects: summary.effects,
					callees: summary.callees
						.map((callee) =>
							functionSummaryId(pathOf.get(callee) ?? summary.sourcePath, callee),
						)
						.sort(),
					openCallEdge: summary.openCallEdge,
					externallyReachable: summary.externallyReachable,
					rootReasons: summary.rootReasons,
					parameterEscape: summary.parameterEscape,
					restParameterEscape: summary.restParameterEscape,
					receiverEscape: summary.receiverEscape,
					parameterContainment: summary.parameterContainment,
					restParameterContainment: summary.restParameterContainment,
					receiverContainment: summary.receiverContainment,
					returnProvenance: summary.returnProvenance,
					returnRepresentation: summary.returnRepresentation,
				},
			];
		},
	);
	return new Map(entries.sort(([left], [right]) => left.localeCompare(right)));
}

export function coreModuleEffectSummaries(
	summaries: CoreProgramSummaries,
): ReadonlyMap<string, ModuleEffectSummary> {
	const pathOf = new Map(
		summaries.functions.map(
			({ functionIndex, sourcePath }) => [functionIndex, sourcePath] as const,
		),
	);
	const entries = summaries.modules.map(
		(module): readonly [string, ModuleEffectSummary] => {
			const id = moduleSummaryId(module.sourcePath);
			return [
				id,
				{
					id,
					sourcePath: module.sourcePath,
					effects: module.effects,
					functions: module.functions
						.map((index) =>
							functionSummaryId(pathOf.get(index) ?? module.sourcePath, index),
						)
						.sort(),
					externallyReachable: module.externallyReachable,
					evaluated: module.evaluated,
				},
			];
		},
	);
	return new Map(entries.sort(([left], [right]) => left.localeCompare(right)));
}

/**
 * Fact encoding of a claim. Deliberately plain data: the verifier re-derives the
 * refinement from it rather than trusting the refinement it finds attached, so
 * this is the whole of what a summary-derived proof asserts.
 */
export function coreCallSummaryFactValue(claim: CoreCallEffectSummaryClaim): {
	readonly targets: ReadonlyArray<number>;
	readonly effects: EffectSummary;
} {
	return { targets: [...claim.targets], effects: { ...claim.effects } };
}

function domainList(value: unknown): ReadonlyArray<EffectDomain> | undefined {
	if (!Array.isArray(value)) return undefined;
	const domains: Array<EffectDomain> = [];
	for (const entry of value) {
		const domain = EFFECT_DOMAINS.find((candidate) => candidate === entry);
		if (domain === undefined) return undefined;
		domains.push(domain);
	}
	return domains;
}

/** Decode a fact value without trusting it; undefined rejects the refinement. */
export function coreCallSummaryClaimFromFactValue(
	value: unknown,
): CoreCallEffectSummaryClaim | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		!Array.isArray(record.targets) ||
		record.targets.some((target) => !Number.isSafeInteger(target) || target < 0) ||
		typeof record.effects !== "object" ||
		record.effects === null
	) {
		return undefined;
	}
	const effects = record.effects as Record<string, unknown>;
	const reads = domainList(effects.reads);
	const writes = domainList(effects.writes);
	if (
		reads === undefined ||
		writes === undefined ||
		typeof effects.mayThrow !== "boolean" ||
		typeof effects.maySuspend !== "boolean" ||
		typeof effects.mayGc !== "boolean" ||
		typeof effects.callsUserCode !== "boolean"
	) {
		return undefined;
	}
	return {
		targets: record.targets as ReadonlyArray<number>,
		effects: {
			reads: normalizeEffectDomains(reads),
			writes: normalizeEffectDomains(writes),
			mayThrow: effects.mayThrow,
			maySuspend: effects.maySuspend,
			mayGc: effects.mayGc,
			callsUserCode: effects.callsUserCode,
		},
	};
}

function valueEscapeFact(value: unknown): ValueEscapeFact | undefined {
	return value === "none" ||
		value === "invoked" ||
		value === "returned" ||
		value === "retained"
		? value
		: undefined;
}

function valueContainmentFact(value: unknown): ValueContainmentFact | undefined {
	return value === "preserved" || value === "unknown" ? value : undefined;
}

function returnRepresentationFact(value: unknown): ReturnRepresentation | undefined {
	return value === "none" ||
		value === "boxed" ||
		value === "f64" ||
		value === "i32" ||
		value === "boolean"
		? value
		: undefined;
}

function returnProvenanceFact(value: unknown): ReturnProvenance | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		record.kind === "none" ||
		record.kind === "fresh" ||
		record.kind === "primitive" ||
		record.kind === "receiver" ||
		record.kind === "unknown"
	) {
		return { kind: record.kind };
	}
	return record.kind === "parameter" &&
		Number.isSafeInteger(record.index) &&
		(record.index as number) >= 0
		? { kind: "parameter", index: record.index as number }
		: undefined;
}

/** Decode proof-carrying value metadata without trusting its shape or digest. */
export function coreCallSummaryClaimFromAttribute(
	value: unknown,
): (CoreCallValueSummaryClaim & { readonly digest: string }) | undefined {
	if (typeof value !== "object" || value === null) return undefined;
	const record = value as Record<string, unknown>;
	if (
		typeof record.digest !== "string" ||
		!Array.isArray(record.targets) ||
		record.targets.some((target) => !Number.isSafeInteger(target) || target < 0) ||
		!Array.isArray(record.argumentEscape) ||
		!Array.isArray(record.argumentContainment)
	) {
		return undefined;
	}
	const receiverEscape = valueEscapeFact(record.receiverEscape);
	const argumentEscape = record.argumentEscape.map(valueEscapeFact);
	const receiverContainment = valueContainmentFact(record.receiverContainment);
	const argumentContainment = record.argumentContainment.map(valueContainmentFact);
	const returnProvenance = returnProvenanceFact(record.returnProvenance);
	const returnRepresentation = returnRepresentationFact(record.returnRepresentation);
	if (
		receiverEscape === undefined ||
		argumentEscape.some((escape) => escape === undefined) ||
		receiverContainment === undefined ||
		argumentContainment.some((containment) => containment === undefined) ||
		returnProvenance === undefined ||
		returnRepresentation === undefined
	) {
		return undefined;
	}
	return {
		digest: record.digest,
		targets: record.targets as ReadonlyArray<number>,
		receiverEscape,
		argumentEscape: argumentEscape as ReadonlyArray<ValueEscapeFact>,
		receiverContainment,
		argumentContainment: argumentContainment as ReadonlyArray<ValueContainmentFact>,
		returnProvenance,
		returnRepresentation,
	};
}
