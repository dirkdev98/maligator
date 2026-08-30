/**
 * Whole-program function reachability over the final Core graph.
 *
 * This is deliberately separate from effect-summary root reasons. Publication is
 * a contextual edge: a closure returned by an unreachable function is not a
 * program root. Starting from the actual image entry points and activating call,
 * publication, namespace, and runtime-table edges only as their containing
 * function becomes executable is what lets an unreachable cycle stay dead.
 */

import type { CompilerSiteFacts } from "../shared/compiler-facts.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import {
	CORE_CALLEE_TARGETS_ATTRIBUTE,
	CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE,
	analyzeCoreCalleeTargets,
} from "./core-ir-call-targets.ts";
import type {
	CoreCalleeTargetAnalysis,
	CoreCalleeTargets,
} from "./core-ir-call-targets.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import {
	CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE,
	CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT,
	CORE_KNOWN_OWN_SLOT_ATTRIBUTE,
} from "./core-ir-shape-provenance.ts";
import { CORE_CALL_EFFECT_SUMMARY_FACT } from "./core-ir-summaries.ts";
import { CORE_CALL_SUMMARY_ATTRIBUTE } from "./core-ir-summaries.ts";
import {
	CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE,
	CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE,
	CORE_PRIMITIVE_OPERATOR_EFFECT_FACT,
} from "./core-ir-value-kinds.ts";
import type {
	CoreAttributeObject,
	CoreAttributeValue,
	CoreInstruction,
	CoreProgram,
	CoreRegion,
	CoreValueId,
} from "./core-ir.ts";
import { CoreFunctionBuilder } from "./core-ir.ts";
import type { CoreFunction } from "./core-ir.ts";

export type CoreFunctionReachabilityReason =
	| "program-entry"
	| "commonjs-module"
	| "host-install"
	| "finite-call"
	| "published-identity"
	| "module-namespace"
	| "any-script"
	| "runtime-identity"
	| "capture-owner"
	| "inline-source";

export interface CoreFunctionReachability {
	/** Functions whose bodies can be entered in this image. */
	readonly executable: ReadonlySet<number>;
	/** Executable functions plus rows required by a live runtime/debug identity. */
	readonly retained: ReadonlySet<number>;
	readonly reasons: ReadonlyMap<number, ReadonlySet<CoreFunctionReachabilityReason>>;
	readonly sourceClosed: boolean;
}

export interface CoreFunctionCompactionResult {
	readonly program: CoreProgram;
	readonly context?: CoreCompilationContext;
	readonly changed: boolean;
	readonly oldToNew: ReadonlyMap<number, number>;
}

function observedOnly(instruction: CoreInstruction): boolean {
	if (coreOpcodeRegistry.get(instruction.opcode)?.observesOperands === true) return true;
	const operator = instruction.attributes.operator;
	return (
		(instruction.opcode === "binary" && (operator === "===" || operator === "!==")) ||
		(instruction.opcode === "unary" && operator === "typeof")
	);
}

function attributeNumber(instruction: CoreInstruction, key: string): number | undefined {
	const value = instruction.attributes[key];
	return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function sourcePositionFunctionIndices(
	program: CoreProgram,
	initial: number | undefined,
): ReadonlySet<number> {
	const result = new Set<number>();
	let position = initial;
	const seen = new Set<number>();
	while (
		position !== undefined &&
		position >= 0 &&
		position < program.sourcePositions.length &&
		!seen.has(position)
	) {
		seen.add(position);
		const entry = program.sourcePositions[position]!;
		if (entry.inlinedFunctionIndex !== undefined) {
			result.add(entry.inlinedFunctionIndex);
		}
		position = entry.callerPosId;
	}
	return result;
}

function sourceFunctionIndices(
	program: CoreProgram,
	fn: CoreFunction,
): ReadonlySet<number> {
	const result = new Set<number>();
	const visit = (position: number | undefined): void => {
		for (const index of sourcePositionFunctionIndices(program, position)) {
			result.add(index);
		}
	};
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) visit(instruction.sourcePosition);
		visit(block.terminator.sourcePosition);
	}
	return result;
}

/**
 * Compute executable bodies and function-table rows from a graph-derived source
 * closure certificate. An open artifact retains everything. For a closed image,
 * finite candidates remain useful even when an opaque native/Proxy alternative
 * accompanies them; only `anyScript` widens to every script body.
 */
export function analyzeCoreFunctionReachability(
	program: CoreProgram,
	targets?: CoreCalleeTargetAnalysis,
	context?: CoreCompilationContext,
): CoreFunctionReachability {
	const all = new Set(program.functions.map(({ functionIndex }) => functionIndex));
	const sourceClosed = context?.facts.closure.sourceClosure.kind === "known";
	if (!sourceClosed) {
		const reasons = new Map<number, ReadonlySet<CoreFunctionReachabilityReason>>();
		for (const index of all) reasons.set(index, new Set(["any-script"]));
		return { executable: all, retained: all, reasons, sourceClosed: false };
	}

	targets ??= analyzeCoreCalleeTargets(program, coreOpcodeRegistry, context);
	const executable = new Set<number>();
	const retained = new Set<number>();
	const reasons = new Map<number, Set<CoreFunctionReachabilityReason>>();
	const pending: Array<number> = [];
	const structuralPending: Array<number> = [];
	const structurallyScanned = new Set<number>();
	const decisionPositions = new Map<number, Array<number>>();
	for (const decision of context?.optimizationDecisions ?? []) {
		const positions = decisionPositions.get(decision.functionIndex) ?? [];
		positions.push(decision.positionId);
		decisionPositions.set(decision.functionIndex, positions);
	}
	const valid = (index: number): boolean =>
		Number.isSafeInteger(index) && index >= 0 && index < program.functions.length;
	const note = (index: number, reason: CoreFunctionReachabilityReason): void => {
		if (!valid(index)) return;
		const current = reasons.get(index) ?? new Set<CoreFunctionReachabilityReason>();
		current.add(reason);
		reasons.set(index, current);
	};
	const retain = (index: number, reason: CoreFunctionReachabilityReason): void => {
		if (!valid(index)) return;
		note(index, reason);
		if (retained.has(index)) return;
		retained.add(index);
		structuralPending.push(index);
	};
	const enter = (index: number, reason: CoreFunctionReachabilityReason): void => {
		if (!valid(index)) return;
		retain(index, reason);
		if (executable.has(index)) return;
		executable.add(index);
		pending.push(index);
	};
	const enterTargets = (
		resolved: CoreCalleeTargets,
		reason: CoreFunctionReachabilityReason,
	): void => {
		if (resolved.anyScript) {
			for (const index of all) enter(index, "any-script");
			return;
		}
		for (const index of resolved.functions) enter(index, reason);
	};
	const retainTargets = (
		resolved: CoreCalleeTargets,
		reason: CoreFunctionReachabilityReason,
	): void => {
		if (resolved.anyScript) {
			for (const index of all) retain(index, reason);
			return;
		}
		for (const index of resolved.functions) retain(index, reason);
	};
	const publish = (
		analysis: CoreCalleeTargetAnalysis,
		owner: number,
		value: CoreValueId,
	): void => enterTargets(analysis.targets(owner, value), "published-identity");
	const retainSourceMetadata = (fn: CoreFunction): void => {
		for (const sourceFunction of sourceFunctionIndices(program, fn)) {
			retain(sourceFunction, "inline-source");
		}
		for (const position of decisionPositions.get(fn.functionIndex) ?? []) {
			for (const sourceFunction of sourcePositionFunctionIndices(program, position)) {
				retain(sourceFunction, "inline-source");
			}
		}
	};

	if (program.functions.length > 0) enter(0, "program-entry");
	for (const index of context?.data.cjsModuleFunctionIndices ?? []) {
		enter(index, "commonjs-module");
	}
	for (const candidate of context?.data.hostInstallCandidates ?? []) {
		for (const { slot } of candidate.exports) {
			enterTargets(targets.globalSlot(slot), "host-install");
		}
	}

	while (pending.length > 0) {
		const functionIndex = pending.pop()!;
		const fn = program.functions[functionIndex];
		if (fn === undefined) continue;
		retainSourceMetadata(fn);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const descriptor = coreOpcodeRegistry.get(instruction.opcode);
				const transfer = descriptor?.callTransfer;
				if (transfer !== undefined) {
					const callee = instruction.inputs[transfer.calleeOperand];
					if (callee !== undefined) {
						enterTargets(targets.targets(functionIndex, callee), "finite-call");
					}
				}

				if (
					instruction.opcode === "loadCaptured" ||
					instruction.opcode === "storeCaptured" ||
					instruction.opcode === "createPrivateNames"
				) {
					const owner = attributeNumber(instruction, "functionIndex");
					if (owner !== undefined && owner >= 0) retain(owner, "capture-owner");
				}
				if (instruction.opcode === "guardFunctionIndex") {
					const target = attributeNumber(instruction, "functionIndex");
					if (target !== undefined) retain(target, "runtime-identity");
				}
				for (const key of [
					"directFunctionIndex",
					"directCallTargetFunctionIndex",
					"directCallbackFunctionIndex",
				]) {
					const target = attributeNumber(instruction, key);
					if (target !== undefined) enter(target, "runtime-identity");
				}
				if (instruction.opcode === "createModuleNamespace") {
					const exports = instruction.attributes.exports;
					if (Array.isArray(exports)) {
						for (const entry of exports) {
							if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
								continue;
							}
							const slot = (entry as CoreAttributeObject).slot;
							if (typeof slot === "number" && Number.isSafeInteger(slot)) {
								enterTargets(targets.globalSlot(slot), "module-namespace");
							}
						}
					}
				}

				if (observedOnly(instruction)) {
					for (const input of instruction.inputs) {
						retainTargets(targets.targets(functionIndex, input), "runtime-identity");
					}
					continue;
				}
				for (const [position, input] of instruction.inputs.entries()) {
					if (transfer !== undefined && position === transfer.calleeOperand) continue;
					if (
						instruction.opcode === "storeGlobal" ||
						instruction.opcode === "storeCaptured" ||
						(instruction.opcode === "setFunctionName" && position === 0)
					) {
						continue;
					}
					publish(targets, functionIndex, input);
				}
			}
			if (block.terminator.kind === "return" || block.terminator.kind === "throw") {
				publish(targets, functionIndex, block.terminator.value);
			}
			for (const edge of block.terminator.kind === "jump"
				? [block.terminator.edge]
				: block.terminator.kind === "branch"
					? [block.terminator.consequent, block.terminator.alternate]
					: block.terminator.kind === "guard"
						? [block.terminator.success, block.terminator.fallback]
						: block.terminator.kind === "switch"
							? [
									block.terminator.default,
									...block.terminator.cases.map(({ edge }) => edge),
								]
							: []) {
				for (const argument of edge.arguments) {
					retainTargets(targets.targets(functionIndex, argument), "runtime-identity");
				}
			}
			for (const argument of block.handler?.arguments ?? []) {
				retainTargets(targets.targets(functionIndex, argument), "runtime-identity");
			}
		}
	}

	// A row kept only for function identity, capture-owner lookup, or inline source
	// attribution is not executable, but its full Core body must remain structurally
	// valid until source metadata and executable rows are split. Retain every row it
	// names without activating that row's call/publication edges.
	while (structuralPending.length > 0) {
		const functionIndex = structuralPending.pop()!;
		if (executable.has(functionIndex) || structurallyScanned.has(functionIndex)) continue;
		structurallyScanned.add(functionIndex);
		const fn = program.functions[functionIndex];
		if (fn === undefined) continue;
		retainSourceMetadata(fn);
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (
					instruction.opcode === "createFunction" ||
					instruction.opcode === "guardFunctionIndex" ||
					instruction.opcode === "loadCaptured" ||
					instruction.opcode === "storeCaptured" ||
					instruction.opcode === "createPrivateNames"
				) {
					const index = attributeNumber(instruction, "functionIndex");
					if (index !== undefined && index >= 0) retain(index, "runtime-identity");
				}
				for (const key of [
					"directFunctionIndex",
					"directCallTargetFunctionIndex",
					"directCallbackFunctionIndex",
				]) {
					const index = attributeNumber(instruction, key);
					if (index !== undefined) retain(index, "runtime-identity");
				}
			}
		}
	}

	return {
		executable,
		retained,
		reasons: new Map(reasons),
		sourceClosed: true,
	};
}

function remapRequired(
	oldToNew: ReadonlyMap<number, number>,
	index: number,
	where: string,
): number {
	const mapped = oldToNew.get(index);
	if (mapped === undefined) {
		throw new Error(
			`Core reachability removed function ${index} still named by ${where}`,
		);
	}
	return mapped;
}

function remapMetadataRequired(
	oldToNew: ReadonlyMap<number, number>,
	index: number,
	where: string,
): number {
	const mapped = oldToNew.get(index);
	if (mapped === undefined) {
		throw new Error(`Core metadata removed index ${index} still named by ${where}`);
	}
	return mapped;
}

const CORE_STRING_INDEX_KEYS: ReadonlySet<string> = new Set([
	"keyStringIndex",
	"nameStringIndex",
	"separatorStringIndex",
	"stringIndex",
]);

const CORE_STRING_INDEX_ARRAY_KEYS: ReadonlySet<string> = new Set([
	"cookedIndices",
	"keyStringIndices",
	"nameStringIndices",
	"rawIndices",
]);

function visitCoreConstantReferences(
	value: unknown,
	noteString: (index: number, where: string) => void,
	noteBigint: (index: number, where: string) => void,
	key?: string,
): void {
	if (typeof value === "number") {
		if (CORE_STRING_INDEX_KEYS.has(key ?? "")) noteString(value, key!);
		else if (key === "bigintIndex") noteBigint(value, key);
		return;
	}
	if (value === null || typeof value !== "object") return;
	if (Array.isArray(value)) {
		if (CORE_STRING_INDEX_ARRAY_KEYS.has(key ?? "")) {
			for (const index of value) {
				if (typeof index !== "number" || (key === "cookedIndices" && index < 0)) {
					continue;
				}
				noteString(index, key!);
			}
			return;
		}
		for (const entry of value) {
			visitCoreConstantReferences(entry, noteString, noteBigint);
		}
		return;
	}
	const object = value as Readonly<Record<string, unknown>>;
	if (object.kind === "string" && typeof object.index === "number") {
		noteString(object.index, "string immediate");
	}
	if (object.kind === "object-slot" && typeof object.key === "number") {
		noteString(object.key, "object-slot key");
	}
	for (const [entryKey, entry] of Object.entries(object)) {
		visitCoreConstantReferences(entry, noteString, noteBigint, entryKey);
	}
}

function remapCoreConstantReferences(
	value: unknown,
	stringOldToNew: ReadonlyMap<number, number>,
	bigintOldToNew: ReadonlyMap<number, number>,
	key?: string,
): unknown {
	if (typeof value === "number") {
		if (CORE_STRING_INDEX_KEYS.has(key ?? "")) {
			return remapMetadataRequired(stringOldToNew, value, key!);
		}
		if (key === "bigintIndex") {
			return remapMetadataRequired(bigintOldToNew, value, key);
		}
		return value;
	}
	if (value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		if (CORE_STRING_INDEX_ARRAY_KEYS.has(key ?? "")) {
			return value.map((index) =>
				typeof index === "number" && key === "cookedIndices" && index < 0
					? index
					: remapMetadataRequired(stringOldToNew, index as number, key!),
			);
		}
		return value.map((entry) =>
			remapCoreConstantReferences(entry, stringOldToNew, bigintOldToNew),
		);
	}
	const object = value as Readonly<Record<string, unknown>>;
	const result: Record<string, unknown> = {};
	for (const [entryKey, entry] of Object.entries(object)) {
		if (entryKey === "index" && object.kind === "string" && typeof entry === "number") {
			result[entryKey] = remapMetadataRequired(stringOldToNew, entry, "string immediate");
			continue;
		}
		if (
			entryKey === "key" &&
			object.kind === "object-slot" &&
			typeof entry === "number"
		) {
			result[entryKey] = remapMetadataRequired(stringOldToNew, entry, "object-slot key");
			continue;
		}
		result[entryKey] = remapCoreConstantReferences(
			entry,
			stringOldToNew,
			bigintOldToNew,
			entryKey,
		);
	}
	return result;
}

function visitLiteralTemplateSegment(
	data: ReadonlyArray<number>,
	offset: number,
	noteString: (index: number, where: string) => void,
	noteBigint: (index: number, where: string) => void,
): number {
	let position = offset;
	const actions: Array<"node" | "property"> = ["node"];
	const take = (where: string): number => {
		if (position >= data.length) {
			throw new Error(`Truncated Core literal-template ${where}`);
		}
		return data[position++]!;
	};
	while (actions.length > 0) {
		const action = actions.pop()!;
		if (action === "property") {
			const tag = take("object key tag");
			if (tag !== 10) throw new Error(`Unknown Core literal-template object tag ${tag}`);
			noteString(take("object key"), "literal-template string");
			actions.push("node");
			continue;
		}
		const tag = take("node");
		switch (tag) {
			case 0:
			case 1:
			case 2:
			case 7:
				break;
			case 3:
				take("integer");
				break;
			case 4:
				take("number low word");
				take("number high word");
				break;
			case 5:
				noteString(take("string"), "literal-template string");
				break;
			case 6:
				noteBigint(take("bigint"), "literal-template bigint");
				break;
			case 8: {
				const count = take("array length");
				for (let index = 0; index < count; index++) actions.push("node");
				break;
			}
			case 9: {
				const count = take("object size");
				for (let index = 0; index < count; index++) actions.push("property");
				break;
			}
			default:
				throw new Error(`Unknown Core literal-template tag ${tag}`);
		}
	}
	return position;
}

function compactLiteralTemplateSegments(
	data: ReadonlyArray<number>,
	liveOffsets: ReadonlySet<number>,
	noteString: (index: number, where: string) => void,
	noteBigint: (index: number, where: string) => void,
): {
	readonly data: ReadonlyArray<number>;
	readonly oldToNew: ReadonlyMap<number, number>;
} {
	const compacted: Array<number> = [];
	const oldToNew = new Map<number, number>();
	for (const offset of [...liveOffsets].sort((left, right) => left - right)) {
		if (!Number.isSafeInteger(offset) || offset < 0 || offset >= data.length) {
			throw new Error(`Core instruction names unknown literal-template offset ${offset}`);
		}
		const end = visitLiteralTemplateSegment(data, offset, noteString, noteBigint);
		oldToNew.set(offset, compacted.length);
		compacted.push(...data.slice(offset, end));
	}
	return { data: compacted, oldToNew };
}

function remapLiteralTemplateConstants(
	data: ReadonlyArray<number>,
	segmentOffsets: ReadonlyArray<number>,
	stringOldToNew: ReadonlyMap<number, number>,
	bigintOldToNew: ReadonlyMap<number, number>,
): ReadonlyArray<number> {
	const remapped = [...data];
	for (const offset of segmentOffsets) {
		let position = offset;
		const actions: Array<"node" | "property"> = ["node"];
		while (actions.length > 0) {
			const action = actions.pop()!;
			if (action === "property") {
				position += 1;
				remapped[position] = remapMetadataRequired(
					stringOldToNew,
					remapped[position]!,
					"literal-template string",
				);
				position += 1;
				actions.push("node");
				continue;
			}
			const tag = remapped[position++]!;
			if (tag === 3) position += 1;
			else if (tag === 4) position += 2;
			else if (tag === 5) {
				remapped[position] = remapMetadataRequired(
					stringOldToNew,
					remapped[position]!,
					"literal-template string",
				);
				position += 1;
			} else if (tag === 6) {
				remapped[position] = remapMetadataRequired(
					bigintOldToNew,
					remapped[position]!,
					"literal-template bigint",
				);
				position += 1;
			} else if (tag === 8) {
				const count = remapped[position++]!;
				for (let index = 0; index < count; index++) actions.push("node");
			} else if (tag === 9) {
				const count = remapped[position++]!;
				for (let index = 0; index < count; index++) actions.push("property");
			}
		}
	}
	return remapped;
}

function remapProofFunctionScopes(
	value: CoreAttributeValue,
	oldToNew: ReadonlyMap<number, number>,
): CoreAttributeValue {
	if (Array.isArray(value)) {
		return (value as ReadonlyArray<CoreAttributeValue>).map((entry) =>
			remapProofFunctionScopes(entry, oldToNew),
		);
	}
	if (value === null || typeof value !== "object") return value;
	const mapped: Record<string, CoreAttributeValue> = {};
	for (const [key, entry] of Object.entries(value)) {
		mapped[key] = remapProofFunctionScopes(entry, oldToNew);
	}
	if (mapped.kind === "function" && typeof mapped.id === "number") {
		mapped.id = remapRequired(oldToNew, mapped.id, "builtin proof scope");
	}
	return mapped;
}

function remapSemanticAttributes(
	instruction: CoreInstruction,
	oldToNew: ReadonlyMap<number, number>,
): CoreInstruction["attributes"] {
	const attributes: Record<string, CoreAttributeValue> = {
		...instruction.attributes,
	};
	if (
		instruction.opcode === "createFunction" ||
		instruction.opcode === "guardFunctionIndex" ||
		instruction.opcode === "loadCaptured" ||
		instruction.opcode === "storeCaptured" ||
		instruction.opcode === "createPrivateNames"
	) {
		const index = attributes.functionIndex;
		if (typeof index === "number" && index >= 0) {
			attributes.functionIndex = remapRequired(
				oldToNew,
				index,
				`${instruction.opcode}.functionIndex`,
			);
		}
	}
	// The optimizer solves these annotations on the exact pre-compaction graph.
	// Removing rows may reveal more precision, but cannot invalidate an existing
	// guarded candidate, so retained singleton indices can be densely rebased.
	for (const key of [
		"directFunctionIndex",
		"directCallTargetFunctionIndex",
		"directCallbackFunctionIndex",
		CORE_FINITE_DISPATCH_TARGET_ATTRIBUTE,
	]) {
		const target = attributes[key];
		if (typeof target === "number") {
			attributes[key] = remapRequired(oldToNew, target, key);
		}
	}
	delete attributes[CORE_CALLEE_TARGETS_ATTRIBUTE];
	delete attributes[CORE_CALL_SUMMARY_ATTRIBUTE];
	// Shape origins are analyzed on the pre-compaction executable graph and rebased
	// in process. Retract target-facing hints here so the final selector can publish
	// the dense function coordinate after all region ownership is settled.
	delete attributes[CORE_KNOWN_OWN_SLOT_ATTRIBUTE];
	delete attributes[CORE_EXACT_SHAPE_OWN_SLOT_ATTRIBUTE];
	delete attributes[CORE_EXACT_BINARY_INPUT_KIND_MASKS_ATTRIBUTE];
	delete attributes[CORE_EXACT_CALL_ARGUMENT_REPRESENTATIONS_ATTRIBUTE];
	if (attributes.knownBuiltinCall !== undefined) {
		attributes.knownBuiltinCall = remapProofFunctionScopes(
			attributes.knownBuiltinCall,
			oldToNew,
		);
	}
	return attributes;
}

function retainedIdentityStub(fn: CoreFunction, functionIndex: number): CoreFunction {
	const builder = new CoreFunctionBuilder(functionIndex, coreOpcodeRegistry, {
		isGenerator: fn.isGenerator,
		isAsync: fn.isAsync,
		parameterCount: fn.parameters.length,
		metadata: fn.metadata,
	});
	const entry = builder.createBlock(fn.parameters.map(() => ({})));
	const [result] = builder.appendInstruction(entry, "createUndefined", []);
	builder.setTerminator(entry, { kind: "return", value: result! });
	return { ...builder.finish(entry), mutationEpoch: fn.mutationEpoch + 1 };
}

function retractMetadataCompactionAnalyses(
	fn: CoreFunction,
	functionOldToNew: ReadonlyMap<number, number>,
): CoreFunction {
	const retractedProofs = new Set(
		fn.facts
			.filter(
				({ kind }) =>
					kind === CORE_CALL_EFFECT_SUMMARY_FACT ||
					kind === CORE_PRIMITIVE_OPERATOR_EFFECT_FACT ||
					kind === CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT,
			)
			.map(({ id }) => id),
	);
	const summaryNarrowedOutputs = new Set(
		fn.blocks.flatMap(({ instructions }) =>
			instructions.flatMap((instruction) =>
				CORE_CALL_SUMMARY_ATTRIBUTE in instruction.attributes ? instruction.outputs : [],
			),
		),
	);
	return {
		...fn,
		blocks: fn.blocks.map((block) => ({
			...block,
			instructions: block.instructions.map((instruction) => ({
				...instruction,
				attributes: remapSemanticAttributes(instruction, functionOldToNew),
				...(instruction.effectRefinement !== undefined &&
				retractedProofs.has(instruction.effectRefinement.proof)
					? { effectRefinement: undefined }
					: {}),
			})),
		})),
		values: fn.values.map((value) =>
			summaryNarrowedOutputs.has(value.id)
				? { ...value, representation: "boxed" }
				: value,
		),
		facts: fn.facts.filter(({ id }) => !retractedProofs.has(id)),
		regions: [],
		mutationEpoch: fn.mutationEpoch + 1,
	};
}

function denseMetadataRelocation(
	length: number,
	live: ReadonlySet<number>,
): ReadonlyMap<number, number> {
	const oldToNew = new Map<number, number>();
	for (let index = 0; index < length; index++) {
		if (live.has(index)) oldToNew.set(index, oldToNew.size);
	}
	return oldToNew;
}

function compactCoreProgramMetadata(
	program: CoreProgram,
	functionOldToNew: ReadonlyMap<number, number>,
	context: CoreCompilationContext | undefined,
	analysisContractRetracted: boolean,
): CoreFunctionCompactionResult {
	const liveStrings = new Set<number>();
	const liveBigints = new Set<number>();
	const liveTemplateOffsets = new Set<number>();
	const notePoolIndex = (
		pool: "string" | "bigint",
		index: number,
		where: string,
	): void => {
		const length =
			pool === "string" ? program.stringConstants.length : program.bigintConstants.length;
		if (!Number.isSafeInteger(index) || index < 0 || index >= length) {
			throw new Error(`Core ${where} names unknown ${pool} constant ${index}`);
		}
		(pool === "string" ? liveStrings : liveBigints).add(index);
	};
	const noteString = (index: number, where: string): void =>
		notePoolIndex("string", index, where);
	const noteBigint = (index: number, where: string): void =>
		notePoolIndex("bigint", index, where);
	const livePositions = new Set<number>();
	const notePosition = (initial: number, where: string): void => {
		let position: number | undefined = initial;
		const chain = new Set<number>();
		while (position !== undefined) {
			const positionIndex: number = position;
			if (chain.has(positionIndex)) break;
			if (
				!Number.isSafeInteger(positionIndex) ||
				positionIndex < 0 ||
				positionIndex >= program.sourcePositions.length
			) {
				throw new Error(`Core ${where} names unknown source position ${positionIndex}`);
			}
			chain.add(positionIndex);
			livePositions.add(positionIndex);
			const sourcePosition: CoreProgram["sourcePositions"][number] =
				program.sourcePositions[positionIndex]!;
			if (
				sourcePosition.inlinedFunctionIndex !== undefined &&
				!functionOldToNew.has(sourcePosition.inlinedFunctionIndex)
			) {
				break;
			}
			const nextPosition: number | undefined = sourcePosition.callerPosId;
			position = nextPosition;
		}
	};

	for (const fn of program.functions) {
		noteString(fn.metadata.nameStringIndex, `function ${fn.functionIndex} name`);
		for (const fact of fn.facts) {
			visitCoreConstantReferences(fact.value, noteString, noteBigint);
		}
		for (const region of fn.regions) {
			visitCoreConstantReferences(region.data, noteString, noteBigint);
		}
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				visitCoreConstantReferences(instruction.attributes, noteString, noteBigint);
				if (instruction.opcode === "instantiateLiteralTemplate") {
					const offset = instruction.attributes.templateOffset;
					if (typeof offset !== "number") {
						throw new Error(
							`Core instantiateLiteralTemplate @${instruction.id} has no template offset`,
						);
					}
					liveTemplateOffsets.add(offset);
				}
				if (instruction.sourcePosition !== undefined) {
					notePosition(instruction.sourcePosition, `instruction @${instruction.id}`);
				}
			}
			if (block.terminator.sourcePosition !== undefined) {
				notePosition(
					block.terminator.sourcePosition,
					`terminator @${block.terminator.id}`,
				);
			}
			if (block.terminator.kind === "switch") {
				for (const entry of block.terminator.cases) {
					visitCoreConstantReferences(entry.value, noteString, noteBigint);
				}
			}
		}
	}
	for (const decision of context?.optimizationDecisions ?? []) {
		notePosition(decision.positionId, "optimization decision");
	}
	const templates = compactLiteralTemplateSegments(
		program.literalTemplateData,
		liveTemplateOffsets,
		noteString,
		noteBigint,
	);

	const stringOldToNew = denseMetadataRelocation(
		program.stringConstants.length,
		liveStrings,
	);
	const bigintOldToNew = denseMetadataRelocation(
		program.bigintConstants.length,
		liveBigints,
	);
	const positionOldToNew = denseMetadataRelocation(
		program.sourcePositions.length,
		livePositions,
	);
	const metadataChanged =
		liveStrings.size !== program.stringConstants.length ||
		liveBigints.size !== program.bigintConstants.length ||
		livePositions.size !== program.sourcePositions.length ||
		templates.data.length !== program.literalTemplateData.length;
	if (!analysisContractRetracted && !metadataChanged) {
		return {
			program,
			...(context === undefined ? {} : { context }),
			changed: false,
			oldToNew: functionOldToNew,
		};
	}
	if (!analysisContractRetracted) {
		return compactCoreProgramMetadata(
			{
				...program,
				functions: program.functions.map((fn) =>
					retractMetadataCompactionAnalyses(fn, functionOldToNew),
				),
			},
			functionOldToNew,
			context,
			true,
		);
	}

	const remapPosition = (position: number, where: string): number =>
		remapMetadataRequired(positionOldToNew, position, where);
	const remapInstructionAttributes = (
		instruction: CoreInstruction,
	): CoreInstruction["attributes"] => {
		const attributes = remapCoreConstantReferences(
			instruction.attributes,
			stringOldToNew,
			bigintOldToNew,
		) as CoreInstruction["attributes"];
		if (instruction.opcode !== "instantiateLiteralTemplate") return attributes;
		return {
			...attributes,
			templateOffset: remapMetadataRequired(
				templates.oldToNew,
				instruction.attributes.templateOffset as number,
				"instantiateLiteralTemplate.templateOffset",
			),
		};
	};
	const functions = program.functions.map(
		(fn): CoreFunction => ({
			...fn,
			metadata: {
				...fn.metadata,
				nameStringIndex: remapMetadataRequired(
					stringOldToNew,
					fn.metadata.nameStringIndex,
					`function ${fn.functionIndex} name`,
				),
			},
			blocks: fn.blocks.map((block) => {
				const terminator = {
					...block.terminator,
					...(block.terminator.sourcePosition === undefined
						? {}
						: {
								sourcePosition: remapPosition(
									block.terminator.sourcePosition,
									`terminator @${block.terminator.id}`,
								),
							}),
					...(block.terminator.kind === "switch"
						? {
								cases: block.terminator.cases.map((entry) => ({
									...entry,
									value: remapCoreConstantReferences(
										entry.value,
										stringOldToNew,
										bigintOldToNew,
									) as typeof entry.value,
								})),
							}
						: {}),
				};
				return {
					...block,
					instructions: block.instructions.map((instruction) => ({
						...instruction,
						attributes: remapInstructionAttributes(instruction),
						...(instruction.sourcePosition === undefined
							? {}
							: {
									sourcePosition: remapPosition(
										instruction.sourcePosition,
										`instruction @${instruction.id}`,
									),
								}),
					})),
					terminator,
				};
			}),
			facts: fn.facts.map((fact) => ({
				...fact,
				value: remapCoreConstantReferences(fact.value, stringOldToNew, bigintOldToNew),
			})),
			regions: fn.regions.map((region) => ({
				...region,
				data: remapCoreConstantReferences(
					region.data,
					stringOldToNew,
					bigintOldToNew,
				) as CoreRegion["data"],
			})),
			mutationEpoch: fn.mutationEpoch + 1,
		}),
	);
	const sourcePositions = program.sourcePositions.flatMap((position, index) => {
		if (!livePositions.has(index)) return [];
		const inlinedFunctionIndex =
			position.inlinedFunctionIndex === undefined
				? undefined
				: functionOldToNew.get(position.inlinedFunctionIndex);
		if (
			position.inlinedFunctionIndex !== undefined &&
			inlinedFunctionIndex === undefined
		) {
			const {
				inlinedFunctionIndex: _inlinedFunctionIndex,
				callerPosId: _callerPosId,
				...leaf
			} = position;
			return [leaf];
		}
		return [
			{
				...position,
				...(inlinedFunctionIndex === undefined ? {} : { inlinedFunctionIndex }),
				...(position.callerPosId === undefined
					? {}
					: {
							callerPosId: remapPosition(
								position.callerPosId,
								`source position ${index} caller`,
							),
						}),
			},
		];
	});
	const remappedContext =
		context === undefined
			? undefined
			: {
					...context,
					...(context.optimizationDecisions === undefined
						? {}
						: {
								optimizationDecisions: context.optimizationDecisions.map((decision) => ({
									...decision,
									positionId: remapPosition(decision.positionId, "optimization decision"),
								})),
							}),
					facts: {
						...context.facts,
						functionEffects: new Map(),
						moduleEffects: new Map(),
						sites: new Map(),
						instructionSites: new WeakMap<object, CompilerSiteFacts>(),
					},
				};
	return {
		changed: true,
		oldToNew: functionOldToNew,
		...(remappedContext === undefined ? {} : { context: remappedContext }),
		program: {
			...program,
			functions,
			stringConstants: program.stringConstants.filter((_value, index) =>
				liveStrings.has(index),
			),
			bigintConstants: program.bigintConstants.filter((_value, index) =>
				liveBigints.has(index),
			),
			literalTemplateData: remapLiteralTemplateConstants(
				templates.data,
				[...templates.oldToNew.values()],
				stringOldToNew,
				bigintOldToNew,
			),
			sourcePositions,
		},
	};
}

/**
 * Densely rebase a closed Core image to the rows and metadata retained by
 * reachability. Summary and region annotations are deliberately retracted.
 * Direct dispatch annotations come from the same target solve as reachability
 * and are rebased.
 */
export function compactCoreProgramFunctions(
	program: CoreProgram,
	reachability?: CoreFunctionReachability,
	context?: CoreCompilationContext,
): CoreFunctionCompactionResult {
	reachability ??= analyzeCoreFunctionReachability(program, undefined, context);
	if (!reachability.sourceClosed) {
		return {
			program,
			...(context === undefined ? {} : { context }),
			changed: false,
			oldToNew: new Map(
				program.functions.map((fn) => [fn.functionIndex, fn.functionIndex]),
			),
		};
	}
	const functionChanged =
		reachability.retained.size !== program.functions.length ||
		reachability.executable.size !== program.functions.length;
	const retained = program.functions.filter((fn) =>
		reachability.retained.has(fn.functionIndex),
	);
	const oldToNew = new Map(
		retained.map((fn, index) => [fn.functionIndex, index] as const),
	);
	if (!functionChanged) {
		return compactCoreProgramMetadata(program, oldToNew, context, false);
	}
	const functions = retained.map((fn, functionIndex): CoreFunction => {
		if (!reachability.executable.has(fn.functionIndex)) {
			return retainedIdentityStub(fn, functionIndex);
		}
		const retractedProofs = new Set(
			fn.facts
				.filter(
					({ kind }) =>
						kind === CORE_CALL_EFFECT_SUMMARY_FACT ||
						kind === CORE_PRIMITIVE_OPERATOR_EFFECT_FACT ||
						kind === CORE_EXACT_SHAPE_OWN_SLOT_EFFECT_FACT,
				)
				.map(({ id }) => id),
		);
		const removedIdentityValues = new Set<number>();
		const summaryNarrowedOutputs = new Set<number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				if (CORE_CALL_SUMMARY_ATTRIBUTE in instruction.attributes) {
					for (const output of instruction.outputs) summaryNarrowedOutputs.add(output);
				}
				if (instruction.opcode !== "createFunction") continue;
				const target = attributeNumber(instruction, "functionIndex");
				if (target === undefined || oldToNew.has(target)) continue;
				for (const output of instruction.outputs) removedIdentityValues.add(output);
			}
		}
		let identityChanged = true;
		while (identityChanged) {
			identityChanged = false;
			for (const block of fn.blocks) {
				for (const instruction of block.instructions) {
					if (
						instruction.opcode !== "move" ||
						instruction.inputs.length !== 1 ||
						!removedIdentityValues.has(instruction.inputs[0]!)
					) {
						continue;
					}
					for (const output of instruction.outputs) {
						if (removedIdentityValues.has(output)) continue;
						removedIdentityValues.add(output);
						identityChanged = true;
					}
				}
			}
		}
		const removedInstructions = new Set<number>();
		const removedValues = new Set<number>();
		for (const block of fn.blocks) {
			for (const instruction of block.instructions) {
				const target =
					instruction.opcode === "createFunction"
						? attributeNumber(instruction, "functionIndex")
						: undefined;
				const removesIdentity =
					(target !== undefined && !oldToNew.has(target)) ||
					(instruction.opcode === "move" &&
						instruction.inputs.some((input) => removedIdentityValues.has(input))) ||
					((instruction.opcode === "storeGlobal" ||
						instruction.opcode === "storeCaptured") &&
						instruction.inputs.some((input) => removedIdentityValues.has(input))) ||
					(instruction.opcode === "setFunctionName" &&
						instruction.inputs[0] !== undefined &&
						removedIdentityValues.has(instruction.inputs[0]));
				if (!removesIdentity) {
					if (instruction.inputs.some((input) => removedIdentityValues.has(input))) {
						throw new Error(
							`Core reachability left removed function identity at @${instruction.id}`,
						);
					}
					continue;
				}
				removedInstructions.add(instruction.id);
				for (const output of instruction.outputs) removedValues.add(output);
			}
		}
		return {
			...fn,
			functionIndex,
			blocks: fn.blocks.map((block) => ({
				...block,
				instructions: block.instructions
					.filter(({ id }) => !removedInstructions.has(id))
					.map((instruction) => ({
						...instruction,
						attributes: remapSemanticAttributes(instruction, oldToNew),
						...(instruction.effectRefinement !== undefined &&
						retractedProofs.has(instruction.effectRefinement.proof)
							? { effectRefinement: undefined }
							: {}),
					})),
			})),
			values: fn.values
				.filter(({ id }) => !removedValues.has(id))
				.map((value) =>
					summaryNarrowedOutputs.has(value.id)
						? { ...value, representation: "boxed" }
						: value,
				),
			facts: fn.facts.filter(({ id }) => !retractedProofs.has(id)),
			regions: [],
			mutationEpoch: fn.mutationEpoch + 1,
		};
	});
	const remapOwner = (owner: number): number =>
		owner < 0 ? owner : remapRequired(oldToNew, owner, "captured-slot metadata");
	const remappedContext =
		context === undefined
			? undefined
			: {
					...context,
					data: {
						...context.data,
						cjsModuleFunctionIndices: context.data.cjsModuleFunctionIndices.map((index) =>
							remapRequired(oldToNew, index, "CommonJS root"),
						),
						singleAssignmentCapturedSlots: context.data.singleAssignmentCapturedSlots
							.filter(({ owner }) => owner < 0 || oldToNew.has(owner))
							.map(({ owner, index }) => ({ owner: remapOwner(owner), index })),
					},
					...(context.optimizationDecisions === undefined
						? {}
						: {
								optimizationDecisions: context.optimizationDecisions.flatMap(
									(decision) => {
										if (!reachability.executable.has(decision.functionIndex)) return [];
										const mapped = oldToNew.get(decision.functionIndex);
										return mapped === undefined
											? []
											: [{ ...decision, functionIndex: mapped }];
									},
								),
							}),
					facts: {
						...context.facts,
						functionEffects: new Map(),
						moduleEffects: new Map(),
						sites: new Map(),
						instructionSites: new WeakMap<object, CompilerSiteFacts>(),
					},
				};
	return compactCoreProgramMetadata(
		{ ...program, functions },
		oldToNew,
		remappedContext,
		functionChanged,
	);
}
