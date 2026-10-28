import {
	COMPILER_VALUE_KIND_NULL,
	COMPILER_VALUE_KIND_NULLISH,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerTypeofComparison,
	compilerValueKindTruthiness,
} from "../shared/compiler-value-kinds.ts";
import type { CoreAnalysisDefinition } from "./core-analysis-manager.ts";
import { CORE_CONTROL_FLOW_BUNDLE_ANALYSIS } from "./core-ir-control-flow.ts";
import type {
	CoreControlEdge,
	CoreControlFlow,
	CoreControlPoint,
} from "./core-ir-control-flow.ts";
import { CORE_LOCAL_VALUE_KIND_ANALYSIS } from "./core-ir-value-kinds.ts";
import type { CoreBlockId, CoreValueId } from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CORE_OPTIMIZATION_OWNER } from "./core-optimization-owners.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

export interface CoreConditionalValueKinds {
	kindMask(value: CoreValueId, point: CoreControlPoint): number;
}

interface Restriction {
	readonly subject: CoreValueId;
	readonly yes: number;
	readonly no: number;
}

interface Bound {
	readonly edge: CoreControlEdge;
	readonly exclusive: boolean;
	readonly mask: number;
}

function alternatives(
	test: (kind: number) => boolean | undefined,
): readonly [number, number] {
	let yes = 0,
		no = 0;
	for (let kind = 1; kind <= COMPILER_VALUE_KIND_OBJECT; kind <<= 1) {
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

function predicateRestrictions(
	program: CoreProgram,
	fn: CoreFunctionStore,
	value: CoreValueId,
	mask: (value: CoreValueId) => number,
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
): CoreConditionalValueKinds {
	const bounds = new Map<CoreValueId, Array<Bound>>();
	for (const block of cfg.reversePostorder) {
		const terminator = fn.blockTerminator(block);
		const kind = fn.instructionKind(terminator);
		if (kind !== "branch" && kind !== "guard") continue;
		const edges = cfg.successors[block]!.filter((edge) => edge.kind === "ordinary");
		const yes = edges[0]!,
			no = edges[1]!;
		for (const restriction of predicateRestrictions(
			program,
			fn,
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(terminator)),
			base,
		)) {
			for (const [edge, mask] of [
				[yes, restriction.yes],
				[no, restriction.no],
			] as const) {
				if (mask === 0 || (base(restriction.subject) & ~mask) === 0) continue;
				const list = bounds.get(restriction.subject) ?? [];
				list.push({ edge, mask, exclusive: yes.to !== no.to });
				bounds.set(restriction.subject, list);
			}
		}
	}
	if (bounds.size === 0) return Object.freeze({ kindMask: base });
	const points = new Map<CoreValueId, Map<CoreBlockId, number>>();
	const at = (value: CoreValueId, block: CoreBlockId): number => {
		const restrictions = bounds.get(value);
		if (restrictions === undefined) return COMPILER_VALUE_KIND_TOP;
		const cached = points.get(value)?.get(block);
		if (cached !== undefined) return cached;
		let mask = COMPILER_VALUE_KIND_TOP;
		for (const restriction of restrictions) {
			// A handler can leave the predicate block before its terminating branch runs.
			if (
				restriction.exclusive &&
				cfg.instructionDominatesBlock(restriction.edge.from, block) &&
				cfg.dominatesEdge(restriction.edge.from, restriction.edge.to, block)
			)
				mask &= restriction.mask;
		}
		const cache = points.get(value) ?? new Map<CoreBlockId, number>();
		cache.set(block, mask);
		points.set(value, cache);
		return mask;
	};
	const onEdge = (value: CoreValueId, edge: CoreControlEdge): number => {
		let mask = at(value, edge.from);
		if (edge.kind === "ordinary")
			for (const restriction of bounds.get(value) ?? [])
				if (
					restriction.edge === edge ||
					(restriction.exclusive &&
						restriction.edge.from === edge.from &&
						restriction.edge.to === edge.to)
				)
					mask &= restriction.mask;
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
			cfg.reachable.has(edge.from),
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
				const input = edge.arguments[edge.kind === "exceptional" ? offset - 1 : offset];
				if (input === undefined) {
					seed |= mask;
				} else {
					inputs.push(input);
					limits.push(onEdge(input, edge));
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
		kindMask(value: CoreValueId, point: CoreControlPoint) {
			const mask = base(value);
			if ((mask & (mask - 1)) === 0) return mask || COMPILER_VALUE_KIND_TOP;
			const phi = phiIndex[value] ?? -1;
			return (
				mask &
					(phi < 0 ? COMPILER_VALUE_KIND_TOP : masks[phi]!) &
					(typeof point === "number" ? at(value, point) : onEdge(value, point)) ||
				mask ||
				COMPILER_VALUE_KIND_TOP
			);
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
