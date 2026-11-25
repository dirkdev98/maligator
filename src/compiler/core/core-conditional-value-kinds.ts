import {
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerTypeofComparison,
	compilerValueKindTruthiness,
} from "../shared/compiler-value-kinds.ts";
import type { HostInputBrand } from "../shared/host-result-contracts.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { coreCallInputFacts } from "./core-call-input-facts.ts";
import type { CoreCallInputFacts } from "./core-call-input-facts.ts";
import {
	CORE_CONTROL_FLOW_BUNDLE_ANALYSIS,
	coreCanonicalValueRoots,
	coreControlPointIsEdge,
} from "./core-ir-control-flow.ts";
import type {
	CoreControlEdge,
	CoreControlFlow,
	CoreControlPoint,
} from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreBlockId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import {
	corePromiseContinuation,
	corePromiseValueIsPrivate,
} from "./core-promise-facts.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface CoreConditionalValueKinds {
	kindMask(
		value: CoreValueId,
		point: CoreControlPoint,
		before?: CoreInstructionId,
	): number;
	heapBrand?(
		value: CoreValueId,
		point: CoreControlPoint,
		before?: CoreInstructionId,
	): HostInputBrand | undefined;
}

interface Restriction {
	readonly subject: CoreValueId;
	readonly yes: number;
	readonly no: number;
	readonly yesBrand?: HostInputBrand;
	readonly noBrand?: HostInputBrand;
	readonly call?: true;
}

interface Bound {
	readonly edge: CoreControlEdge;
	readonly exclusive: boolean;
	readonly mask: number;
	readonly brand?: HostInputBrand;
}

interface NormalBound {
	readonly instruction: CoreInstructionId;
	readonly block: CoreBlockId;
	readonly mask: number;
	readonly brand?: HostInputBrand;
}

function alternatives(
	test: (kind: number) => boolean | undefined,
): readonly [number, number] {
	let yes = 0,
		no = 0;
	for (let kind = 1; kind <= COMPILER_VALUE_KIND_TOP; kind <<= 1) {
		const result = test(kind);
		if (result !== false) yes |= kind;
		if (result !== true) no |= kind;
	}
	return [yes, no];
}

const truthyKinds = alternatives(compilerValueKindTruthiness);
const typeofKinds = new Map<string, readonly [number, number]>(
	(
		[
			"undefined",
			"boolean",
			"number",
			"bigint",
			"string",
			"symbol",
			"object",
			"function",
		] as const
	).map((expected) => [
		expected,
		alternatives((kind) => compilerTypeofComparison(kind, expected)),
	]),
);
const unknownTypeofKinds = [0, COMPILER_VALUE_KIND_TOP] as const;

export function corePredicateRestrictions(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	mask: (value: CoreValueId) => number,
	callFacts: (instruction: CoreInstructionId) => CoreCallInputFacts | undefined,
): ReadonlyArray<Restriction> {
	let negated = false;
	const seen = new Set<CoreValueId>();
	while (fn.kernel.valueDefinitionKind(value) === 1 && !seen.has(value)) {
		seen.add(value);
		const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const opcode = fn.instructionOpcodeName(definition);
		const attributes = fn.instructionAttributes(definition);
		const start = fn.kernel.instructionOperandStart(definition);
		const input = fn.kernel.operandAt(start);
		const restrict = (
			subject: CoreValueId,
			kinds: readonly [number, number],
		): Restriction => ({
			subject,
			yes: kinds[negated ? 1 : 0],
			no: kinds[negated ? 0 : 1],
		});
		if (opcode === "move" || (opcode === "unary" && attributes.operator === "!")) {
			negated = negated !== (opcode === "unary");
			value = input;
			continue;
		}
		const inputs = callFacts(definition);
		if (inputs?.onTrue !== undefined || inputs?.onFalse !== undefined) {
			const restrictions = new Map<CoreValueId, Restriction>();
			for (const [positive, bounds] of [
				[true, inputs.onTrue],
				[false, inputs.onFalse],
			] as const) {
				for (const { index, mask, brand } of bounds ?? []) {
					const subject = fn.kernel.operandAt(start + index);
					const prior = restrictions.get(subject) ?? {
						subject,
						yes: COMPILER_VALUE_KIND_TOP,
						no: COMPILER_VALUE_KIND_TOP,
						call: true,
					};
					restrictions.set(
						subject,
						positive !== negated
							? { ...prior, yes: prior.yes & mask, yesBrand: brand ?? prior.yesBrand }
							: { ...prior, no: prior.no & mask, noBrand: brand ?? prior.noBrand },
					);
				}
			}
			return [...restrictions.values()];
		}
		if (opcode === "typeofCompare" && typeof attributes.expected === "string") {
			let kinds = typeofKinds.get(attributes.expected) ?? unknownTypeofKinds;
			if (attributes.negated === true) kinds = [kinds[1], kinds[0]];
			return [restrict(input, kinds)];
		}
		if (
			opcode === "binary" &&
			typeof attributes.operator === "string" &&
			["===", "!==", "==", "!="].includes(attributes.operator)
		) {
			const right = fn.kernel.operandAt(start + 1);
			const rawTypeof = (
				type: CoreValueId,
				text: CoreValueId,
			): Restriction | undefined => {
				if (
					fn.kernel.valueDefinitionKind(type) !== 1 ||
					fn.kernel.valueDefinitionKind(text) !== 1
				)
					return undefined;
				const typeDefinition = coreInstructionId(fn.kernel.valueDefinitionOwner(type));
				const textDefinition = coreInstructionId(fn.kernel.valueDefinitionOwner(text));
				if (
					fn.instructionOpcodeName(typeDefinition) !== "unary" ||
					fn.instructionAttributes(typeDefinition).operator !== "typeof" ||
					fn.instructionOpcodeName(textDefinition) !== "createString"
				)
					return undefined;
				const index = fn.instructionAttributes(textDefinition).stringIndex;
				const units =
					typeof index === "number" ? program.stringConstants[index] : undefined;
				if (units === undefined || units.length > 9) return undefined;
				const expected = String.fromCharCode(...units);
				const kinds = typeofKinds.get(expected) ?? unknownTypeofKinds;
				return restrict(
					fn.kernel.operandAt(fn.kernel.instructionOperandStart(typeDefinition)),
					kinds,
				);
			};
			negated =
				negated !== (attributes.operator === "!==" || attributes.operator === "!=");
			const type = rawTypeof(input, right) ?? rawTypeof(right, input);
			if (type !== undefined) return [type];
			const fulfillment = (mode: CoreValueId, thrown: CoreValueId) => {
				if (
					!fn.isAsync ||
					fn.kernel.valueDefinitionKind(mode) !== 1 ||
					fn.kernel.valueDefinitionIndex(mode) !== 1 ||
					fn.kernel.valueDefinitionKind(thrown) !== 1
				)
					return undefined;
				const awaitInstruction = coreInstructionId(fn.kernel.valueDefinitionOwner(mode));
				const constant = coreInstructionId(fn.kernel.valueDefinitionOwner(thrown));
				// Await's resume mode is 1 on rejection. The other branch
				// remains the success proof even if the payload is unused.
				if (
					fn.instructionOpcodeName(awaitInstruction) !== "await" ||
					fn.instructionOpcodeName(constant) !== "createNumber" ||
					fn.instructionAttributes(constant).value !== 1
				)
					return undefined;
				let promise = fn.kernel.operandAt(
					fn.kernel.instructionOperandStart(awaitInstruction),
				);
				for (
					let depth = 0;
					depth < 4 && fn.kernel.valueDefinitionKind(promise) === 1;
					depth++
				) {
					const producer = coreInstructionId(fn.kernel.valueDefinitionOwner(promise));
					const facts = callFacts(producer)?.onFulfill;
					if (facts !== undefined) {
						if (!corePromiseValueIsPrivate(program, fn, promise)) return undefined;
						const inputs = fn.kernel.instructionOperandStart(producer);
						return facts.map(({ index, mask, brand }): Restriction => ({
							...restrict(fn.kernel.operandAt(inputs + index), [
								COMPILER_VALUE_KIND_TOP,
								mask,
							]),
							...(negated ? { yesBrand: brand } : { noBrand: brand }),
							call: true,
						}));
					}
					if (fn.instructionOpcodeName(producer) === "move") {
						promise = fn.kernel.operandAt(fn.kernel.instructionOperandStart(producer));
						continue;
					}
					const then = corePromiseContinuation(program, fn, producer);
					if (
						then?.method !== "then" ||
						then.second !== undefined ||
						!corePromiseValueIsPrivate(program, fn, promise)
					)
						break;
					promise = then.receiver;
				}
				return undefined;
			};
			const settled = fulfillment(input, right) ?? fulfillment(right, input);
			if (settled !== undefined) return settled;
			const leftMask = mask(input),
				rightMask = mask(right);
			if (attributes.operator === "===" || attributes.operator === "!==") {
				const singleton = (kind: number) =>
					kind === COMPILER_VALUE_KIND_NULL || kind === COMPILER_VALUE_KIND_UNDEFINED;
				return [
					restrict(input, [
						rightMask,
						singleton(rightMask)
							? COMPILER_VALUE_KIND_TOP & ~rightMask
							: COMPILER_VALUE_KIND_TOP,
					]),
					restrict(right, [
						leftMask,
						singleton(leftMask)
							? COMPILER_VALUE_KIND_TOP & ~leftMask
							: COMPILER_VALUE_KIND_TOP,
					]),
				];
			}
			if ((leftMask & ~COMPILER_VALUE_KIND_NULLISH) === 0)
				return [
					restrict(right, [
						COMPILER_VALUE_KIND_NULLISH,
						COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_NULLISH,
					]),
				];
			if ((rightMask & ~COMPILER_VALUE_KIND_NULLISH) === 0)
				return [
					restrict(input, [
						COMPILER_VALUE_KIND_NULLISH,
						COMPILER_VALUE_KIND_TOP & ~COMPILER_VALUE_KIND_NULLISH,
					]),
				];
		}
		break;
	}
	return [
		{
			subject: value,
			yes: truthyKinds[negated ? 1 : 0],
			no: truthyKinds[negated ? 0 : 1],
		},
	];
}

export function analyzeCoreConditionalValueKinds(
	program: CoreProgram,
	fn: CoreFunctionStore,
	cfg: CoreControlFlow,
	base: (value: CoreValueId) => number,
	callFacts = (instruction: CoreInstructionId) => coreCallInputFacts(fn, instruction),
): CoreConditionalValueKinds {
	const bounds = new Map<CoreValueId, Array<Bound>>();
	const callBounds = new Map<CoreValueId, Array<Bound>>();
	const normal = new Map<CoreValueId, Array<NormalBound>>();
	let roots: ReturnType<typeof coreCanonicalValueRoots> | undefined;
	const root = (value: CoreValueId) =>
		(roots ??= coreCanonicalValueRoots(fn, cfg)).get(value) ?? value;
	const callOpcode = fn.registry.get("call")?.id;
	const builtinOpcode = fn.registry.get("callKnown")?.id;
	for (const instruction of fn.instructionIds()) {
		const opcode = fn.kernel.instructionOpcode(instruction);
		if (opcode !== callOpcode && opcode !== builtinOpcode) continue;
		const facts = callFacts(instruction)?.onReturn;
		if (facts === undefined) continue;
		const start = fn.kernel.instructionOperandStart(instruction);
		const block = fn.instructionBlock(instruction);
		for (const { index, mask, brand } of facts) {
			const value = root(fn.kernel.operandAt(start + index));
			const list = normal.get(value) ?? [];
			list.push({ instruction, block, mask, brand });
			normal.set(value, list);
		}
	}
	for (const block of cfg.reversePostorder) {
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind !== "branch" && kind !== "guard") continue;
		const edges = cfg.successors[block]!.filter(
			(edge) => cfg.edges.kind(edge) === "ordinary",
		);
		const yes = edges[0]!,
			no = edges[1]!;
		for (const restriction of corePredicateRestrictions(
			program,
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
			base,
			callFacts,
		)) {
			for (const [edge, mask, brand] of [
				[yes, restriction.yes, restriction.yesBrand],
				[no, restriction.no, restriction.noBrand],
			] as const) {
				if (
					mask === 0 ||
					(brand === undefined && (base(restriction.subject) & ~mask) === 0)
				)
					continue;
				const table = restriction.call ? callBounds : bounds;
				const value = restriction.call ? root(restriction.subject) : restriction.subject;
				const list = table.get(value) ?? [];
				list.push({
					edge,
					mask,
					brand,
					exclusive: cfg.edges.to(yes) !== cfg.edges.to(no),
				});
				table.set(value, list);
			}
		}
	}
	if (bounds.size === 0 && callBounds.size === 0 && normal.size === 0)
		return Object.freeze({ kindMask: base });
	const active = (bound: Bound, block: CoreBlockId, edge?: CoreControlEdge) =>
		bound.edge === edge ||
		(bound.exclusive &&
			((edge !== undefined &&
				cfg.edges.from(bound.edge) === cfg.edges.from(edge) &&
				cfg.edges.to(bound.edge) === cfg.edges.to(edge)) ||
				cfg.dominatesEdge(cfg.edges.from(bound.edge), cfg.edges.to(bound.edge), block)));
	const pointMasks = new Map<CoreValueId, Map<CoreBlockId, number>>();
	const callMasks = new Map<CoreValueId, Map<CoreBlockId, number>>();
	const at = (
		table: ReadonlyMap<CoreValueId, Array<Bound>>,
		points: Map<CoreValueId, Map<CoreBlockId, number>>,
		value: CoreValueId,
		block: CoreBlockId,
		edge?: CoreControlEdge,
	): number => {
		const restrictions = table.get(value);
		if (restrictions === undefined) return COMPILER_VALUE_KIND_TOP;
		const cached = edge === undefined ? points.get(value)?.get(block) : undefined;
		if (cached !== undefined) return cached;
		let mask = COMPILER_VALUE_KIND_TOP;
		for (const restriction of restrictions) {
			// A dominating ordinary edge executes after its source instructions.
			if (active(restriction, block, edge)) mask &= restriction.mask;
		}
		if (edge === undefined) {
			const cache = points.get(value) ?? new Map<CoreBlockId, number>();
			cache.set(block, mask);
			points.set(value, cache);
		}
		return mask;
	};
	const positions = new Map<CoreInstructionId, number>();
	const blockOrder = new Set<CoreBlockId>();
	const order = (block: CoreBlockId, instruction: CoreInstructionId) => {
		if (!blockOrder.has(block)) {
			blockOrder.add(block);
			let position = 0;
			for (const candidate of fn.bodyInstructionIds(block))
				positions.set(candidate, position++);
		}
		return positions.get(instruction) ?? Number.POSITIVE_INFINITY;
	};
	const completesBefore = (
		bound: NormalBound,
		block: CoreBlockId,
		edge: CoreControlEdge | undefined,
		before: CoreInstructionId | undefined,
	) => {
		if (bound.block !== block) return cfg.instructionDominatesBlock(bound.block, block);
		if (edge !== undefined) return cfg.edges.kind(edge) === "ordinary";
		return before !== undefined && order(block, bound.instruction) < order(block, before);
	};
	const limitAt = (
		value: CoreValueId,
		point: CoreControlPoint,
		before?: CoreInstructionId,
	) => {
		const edge = coreControlPointIsEdge(point) ? point : undefined;
		const block = edge === undefined ? (point as CoreBlockId) : cfg.edges.from(edge);
		const ordinary =
			edge !== undefined && cfg.edges.kind(edge) === "ordinary" ? edge : undefined;
		let mask = at(bounds, pointMasks, value, block, ordinary);
		if (roots !== undefined) {
			const canonical = root(value);
			mask &= at(callBounds, callMasks, canonical, block, ordinary);
			for (const bound of normal.get(canonical) ?? [])
				if (completesBefore(bound, block, edge, before)) mask &= bound.mask;
		}
		return mask;
	};
	const phiIndex = new Int32Array(fn.valueCapacity);
	phiIndex.fill(-1);
	const outputs: Array<CoreValueId> = [],
		seeds: Array<number> = [],
		starts: Array<number> = [],
		counts: Array<number> = [],
		inputs: Array<CoreValueId> = [],
		limits: Array<number> = [];
	for (const block of cfg.reversePostorder) {
		const start = fn.kernel.blockParameterStart(block),
			count = fn.kernel.blockParameterCount(block);
		const incoming = (cfg.predecessors[block] ?? []).filter((edge) =>
			cfg.reachable.has(cfg.edges.from(edge)),
		);
		if (incoming.length === 0) continue;
		for (let offset = 0; offset < count; offset++) {
			const value = fn.kernel.blockParameterValue(start + offset),
				mask = base(value);
			if (
				(block === fn.entry && offset < fn.parameterCount) ||
				fn.kernel.blockParameterRole(start + offset) === 1 ||
				(mask & (mask - 1)) === 0
			)
				continue;
			phiIndex[value] = outputs.length;
			outputs.push(value);
			starts.push(inputs.length);
			let seed = 0;
			for (const edge of incoming) {
				const input = cfg.edges.argument(
					edge,
					cfg.edges.kind(edge) === "exceptional" ? offset - 1 : offset,
				);
				if (input === undefined) {
					seed |= mask;
				} else {
					inputs.push(input);
					limits.push(limitAt(input, edge));
				}
			}
			seeds.push(seed);
			counts.push(inputs.length - starts.at(-1)!);
		}
	}
	const masks = Uint16Array.from(seeds),
		heads = new Int32Array(outputs.length);
	heads.fill(-1);
	const next = new Int32Array(inputs.length),
		dependents = new Int32Array(inputs.length);
	let links = 0;
	for (let node = 0; node < outputs.length; node++)
		for (let offset = 0; offset < counts[node]!; offset++) {
			const input = phiIndex[inputs[starts[node]! + offset]!]!;
			if (input < 0) continue;
			next[links] = heads[input]!;
			dependents[links] = node;
			heads[input] = links++;
		}
	const queue = outputs.map((_, index) => index),
		queued = new Uint8Array(outputs.length);
	queued.fill(1);
	for (let cursor = 0; cursor < queue.length; cursor++) {
		const node = queue[cursor]!;
		queued[node] = 0;
		let mask = masks[node]!;
		for (let offset = 0; offset < counts[node]!; offset++) {
			const index = starts[node]! + offset,
				value = inputs[index]!,
				phi = phiIndex[value]!;
			mask |= (phi < 0 ? base(value) : masks[phi]!) & limits[index]!;
		}
		mask &= base(outputs[node]!);
		if (mask === masks[node]) continue;
		masks[node] = mask;
		for (let link = heads[node]!; link >= 0; link = next[link]!) {
			const dependent = dependents[link]!;
			if (queued[dependent] !== 0) continue;
			queued[dependent] = 1;
			queue.push(dependent);
		}
	}
	return Object.freeze({
		kindMask(value: CoreValueId, point: CoreControlPoint, before?: CoreInstructionId) {
			const mask = base(value);
			if ((mask & (mask - 1)) === 0) return mask || COMPILER_VALUE_KIND_TOP;
			const phi = phiIndex[value] ?? -1;
			return (
				mask &
					(phi < 0 ? COMPILER_VALUE_KIND_TOP : masks[phi]!) &
					limitAt(value, point, before) ||
				mask ||
				COMPILER_VALUE_KIND_TOP
			);
		},
		heapBrand(value: CoreValueId, point: CoreControlPoint, before?: CoreInstructionId) {
			if (roots === undefined) return undefined;
			const canonical = root(value);
			const edge = coreControlPointIsEdge(point) ? point : undefined;
			const block = edge === undefined ? (point as CoreBlockId) : cfg.edges.from(edge);
			const ordinary =
				edge !== undefined && cfg.edges.kind(edge) === "ordinary" ? edge : undefined;
			let brand: HostInputBrand | undefined;
			for (const bound of callBounds.get(canonical) ?? []) {
				if (bound.brand === undefined || !active(bound, block, ordinary)) continue;
				if (brand !== undefined && brand !== bound.brand) return undefined;
				brand = bound.brand;
			}
			for (const bound of normal.get(canonical) ?? []) {
				if (bound.brand === undefined || !completesBefore(bound, block, edge, before))
					continue;
				if (brand !== undefined && brand !== bound.brand) return undefined;
				brand = bound.brand;
			}
			return brand;
		},
	});
}

export const CORE_CONDITIONAL_VALUE_KIND_ANALYSIS: CoreAnalysisDefinition<CoreConditionalValueKinds> =
	{
		key: "conditional-value-kinds",
		scope: "function",
		owner: CORE_OPTIMIZATION_OWNER.localValueKinds,
		functionDependencies: [
			"body",
			"cfg",
			"exceptionFlow",
			"memoryEffects",
			"normalResults",
			"representations",
		],
		contextIdentity: (context) => context,
		compute({ program, request, get }) {
			if (request.scope !== "function") throw new Error("Expected function analysis");
			const kinds = get(CORE_LOCAL_VALUE_KIND_ANALYSIS, request);
			return analyzeCoreConditionalValueKinds(
				program,
				program.function(request.function),
				get(CORE_CONTROL_FLOW_BUNDLE_ANALYSIS, request).exceptional(),
				(value) => kinds.kindMask(value),
			);
		},
	};
