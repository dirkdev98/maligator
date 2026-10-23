import type { ReadAccessorSummary } from "../shared/effect-summary.ts";
import type { CoreEditor } from "./core-editor.ts";
import { coreInstanceMethodHint } from "./core-instance-method-hints.ts";
import type { CoreInstanceMethodHints } from "./core-instance-method-hints.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreTerminatorInput, mapCoreTerminatorEdges } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreModulePrivateNameIndex } from "./core-private-names.ts";
import {
	accessorPrefixKey,
	coreReadAccessorLoopPlan,
	invalidateCoreReadAccessorLoopAnalysis,
} from "./core-read-accessor-loops.ts";
import type { CoreReadAccessorLoopPlan } from "./core-read-accessor-loops.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";
import type { CoreTransformCandidate } from "./core-transform-candidates.ts";

function operands(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) =>
			fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + index),
	);
}

function results(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	return Array.from(
		{ length: fn.kernel.instructionResultCount(instruction) },
		(_, index) =>
			fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction) + index),
	);
}

interface AccessorCall {
	readonly target: CoreFunctionId;
	readonly summary: ReadAccessorSummary;
}

export interface ReadRegion {
	readonly block: CoreBlockId;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly calls: ReadonlyMap<CoreInstructionId, AccessorCall>;
}

export interface CoreReadAccessorRegionPlan {
	readonly bodyVersion: number;
	readonly cfgVersion: number;
	readonly exceptionFlowVersion: number;
	readonly memoryEffectsVersion: number;
	readonly region: ReadRegion;
	readonly completeTerminalRead: boolean;
	readonly loop?: CoreReadAccessorLoopPlan;
}

export interface CoreReadAccessorWork {
	accessorRegionDiscoveries: number;
	accessorInstructionVisits: number;
	accessorPlansReused: number;
	accessorRegionsOffered: number;
	accessorRegionsApplied: number;
	accessorLoopRegionsApplied: number;
	accessorLoopAnalysisWork: number;
	accessorLoopApplications?: Array<{
		caller: number;
		name: string;
		site: number;
		header: number;
		prefixes: ReadonlyArray<string>;
		retainedPrefixes: ReadonlyArray<string>;
		numericGuards: ReadonlyArray<number>;
		invalidations: ReadonlyArray<number>;
	}>;
	accessorApplications?: Array<{ caller: number; name: string; site: number }>;
}

export const EMPTY_CORE_READ_ACCESSOR_WORK: Readonly<CoreReadAccessorWork> =
	Object.freeze({
		accessorRegionDiscoveries: 0,
		accessorInstructionVisits: 0,
		accessorPlansReused: 0,
		accessorRegionsOffered: 0,
		accessorRegionsApplied: 0,
		accessorLoopRegionsApplied: 0,
		accessorLoopAnalysisWork: 0,
	});

type ReadAccessorAnchor = Pick<
	CoreTransformCandidate,
	"caller" | "site" | "targets" | "readAccessorRegion" | "readAccessorLoopEligible"
>;

function accessorArgumentsMayAdmit(
	fn: CoreFunctionStore,
	inputs: ReadonlyArray<CoreValueId>,
	summary: ReadAccessorSummary,
): boolean {
	for (const read of summary.reads) {
		if (read.kind !== "indexed") continue;
		let value = inputs[read.argument + 2];
		if (value === undefined) return false;
		for (let depth = 0; depth < 16; depth++) {
			if (fn.kernel.valueDefinitionKind(value) !== 1) break;
			const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
			const opcode = fn.instructionOpcodeName(instruction);
			if (opcode === "move") {
				value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
				continue;
			}
			switch (opcode) {
				case "createNumber":
				case "createF64": {
					const number = fn.instructionAttributes(instruction).value;
					if (
						typeof number !== "number" ||
						!Number.isInteger(number) ||
						number < 0 ||
						number >= 0xffff_ffff
					)
						return false;
					break;
				}
				case "createString":
				case "createBoolean":
				case "createNull":
				case "createUndefined":
				case "createBigint":
					return false;
			}
			break;
		}
	}
	return true;
}

function regionInstruction(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	conditionalNumbers = false,
): boolean {
	const opcode = fn.instructionOpcodeName(instruction);
	if (
		conditionalNumbers &&
		opcode === "binary" &&
		[
			"+",
			"-",
			"*",
			"/",
			"%",
			"<",
			"<=",
			">",
			">=",
			"==",
			"===",
			"!=",
			"!==",
			"&",
			"|",
			"^",
			"<<",
			">>",
			">>>",
		].includes(fn.instructionAttributes(instruction).operator as string)
	)
		return true;
	if (opcode === "loadPropertyStatic" || opcode === "loadPrivate") return true;
	const effects = coreInstructionEffects(fn, instruction);
	return (
		!effects.mayThrow &&
		!effects.mayGc &&
		!effects.callsUserCode &&
		!effects.maySuspend &&
		effects.writes.length === 0 &&
		fn.instructionEffectRefinement(instruction) === undefined
	);
}

function readRegion(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	candidate: ReadAccessorAnchor,
	hints: CoreInstanceMethodHints,
	reusePlan = true,
	work?: CoreReadAccessorWork,
	conditionalNumbers = false,
): ReadRegion | undefined {
	const fn = program.function(candidate.caller);
	if (
		!fn.isInstructionLive(candidate.site) ||
		fn.instructionAttributes(candidate.site)[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] ===
			true
	)
		return undefined;
	const planned = candidate.readAccessorRegion;
	if (
		reusePlan &&
		planned !== undefined &&
		planned.bodyVersion === fn.version("body") &&
		planned.cfgVersion === fn.version("cfg") &&
		planned.memoryEffectsVersion === fn.version("memoryEffects") &&
		[...planned.region.calls.values()].every(
			(call) => summaries.summary(call.target)?.readAccessor === call.summary,
		)
	) {
		if (work !== undefined) work.accessorPlansReused++;
		return planned.region;
	}
	if (work !== undefined) work.accessorRegionDiscoveries++;
	const block = fn.instructionBlock(candidate.site);
	const accessorCall = (instruction: CoreInstructionId): AccessorCall | undefined => {
		if (
			fn.instructionOpcodeName(instruction) !== "call" ||
			fn.instructionAttributes(instruction)[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] ===
				true
		)
			return undefined;
		const site = summaries.targets.site(fn.id, instruction),
			inputs = operands(fn, instruction);
		const target =
			instruction === candidate.site
				? candidate.targets[0]
				: site?.targets.functions.length === 1
					? site.targets.functions[0]
					: coreInstanceMethodHint(fn, inputs[0]!, inputs[1], hints);
		const summary =
			target === undefined ? undefined : summaries.summary(target)?.readAccessor;
		const output = results(fn, instruction);
		return target !== undefined &&
			summary !== undefined &&
			accessorArgumentsMayAdmit(fn, inputs, summary) &&
			output.length === 1 &&
			fn.valueRepresentation(output[0]!) === "boxed"
			? { target, summary }
			: undefined;
	};
	const anchor = accessorCall(candidate.site);
	if (anchor === undefined) return undefined;
	let start = candidate.site;
	for (let count = 0; count < 12; count++) {
		const previous = fn.instructionPrevious(start);
		if (work !== undefined && previous !== undefined) work.accessorInstructionVisits++;
		if (
			previous === undefined ||
			fn.instructionKind(previous) !== "operation" ||
			(!regionInstruction(fn, previous, conditionalNumbers) &&
				accessorCall(previous) === undefined)
		)
			break;
		start = previous;
	}
	const calls = new Map<CoreInstructionId, AccessorCall>();
	const instructions: Array<CoreInstructionId> = [];
	let instruction: CoreInstructionId | undefined = start;
	for (
		let count = 0;
		instruction !== undefined &&
		fn.instructionKind(instruction) === "operation" &&
		count < 40;
		count++, instruction = fn.instructionNext(instruction)
	) {
		if (work !== undefined) work.accessorInstructionVisits++;
		if (fn.instructionOpcodeName(instruction) !== "call") {
			if (!regionInstruction(fn, instruction, conditionalNumbers)) break;
			instructions.push(instruction);
			continue;
		}
		const call = instruction === candidate.site ? anchor : accessorCall(instruction);
		if (call === undefined || calls.size >= 6) break;
		calls.set(instruction, call);
		instructions.push(instruction);
	}
	if (!calls.has(candidate.site)) return undefined;
	const lastCall = instructions.indexOf([...calls.keys()].at(-1)!);
	return { block, instructions: instructions.slice(0, lastCall + 1), calls };
}

export function coreReadAccessorRegionCost(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	candidate: ReadAccessorAnchor,
	hints: CoreInstanceMethodHints,
	work?: CoreReadAccessorWork,
):
	| {
			generatedCode: number;
			compilerWork: number;
			loopPrefixCount: number;
			sites: ReadonlyArray<CoreInstructionId>;
			plan: CoreReadAccessorRegionPlan;
	  }
	| undefined {
	let region = readRegion(program, summaries, candidate, hints, true, work);
	if (region === undefined) return undefined;
	const fn = program.function(candidate.caller);
	const conditional =
		candidate.readAccessorLoopEligible === true &&
		[...region.calls.values()].some(({ summary }) =>
			summary.reads.some((read) => read.kind === "indexed"),
		)
			? readRegion(program, summaries, candidate, hints, false, work, true)
			: undefined;
	let loopAnalysisWork = 0;
	const loop =
		conditional === undefined
			? undefined
			: coreReadAccessorLoopPlan(program, fn, conditional, (units) => {
					loopAnalysisWork += units;
					if (work !== undefined) work.accessorLoopAnalysisWork += units;
				});
	if (loop !== undefined) region = conditional!;
	// A single field read has no sharing benefit and retains the ordinary inline fast path.
	if (
		region.calls.size === 1 &&
		region.calls.values().next().value!.summary.reads.length === 1
	)
		return undefined;
	const completeTerminalRead =
		loop === undefined &&
		region.calls.size === 1 &&
		region.calls.values().next().value!.summary.reads.at(-1)?.kind === "indexed";
	const loopCost =
		loop === undefined
			? 0
			: region.instructions.length +
				loop.prefixes.length * 6 +
				loop.numericGuards.length * 3 +
				loop.loop.blocks.size * (loop.retainedPrefixes.length + 2) * 2 +
				12;
	const generatedCode =
		(completeTerminalRead ? 3 : 0) +
		loopCost +
		region.instructions.length * 2 +
		[...region.calls.values()].reduce(
			(cost, { summary }) =>
				cost +
				2 +
				summary.reads.length * 3 +
				(summary.defaultValue === undefined ? 0 : 5),
			0,
		);
	return {
		generatedCode,
		compilerWork: generatedCode * 2 + region.instructions.length + loopAnalysisWork,
		loopPrefixCount: loop?.invalidators.size === 0 ? loop.prefixes.length : 0,
		sites: [...region.calls.keys()],
		plan: {
			bodyVersion: fn.version("body"),
			cfgVersion: fn.version("cfg"),
			exceptionFlowVersion: fn.version("exceptionFlow"),
			memoryEffectsVersion: fn.version("memoryEffects"),
			region,
			completeTerminalRead,
			...(loop === undefined ? {} : { loop }),
		},
	};
}

export function expandCoreReadAccessorRegion(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	names: CoreModulePrivateNameIndex,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
	hints: CoreInstanceMethodHints,
	work?: CoreReadAccessorWork,
): { instructionsIntroduced: number; blocksIntroduced: number } | undefined {
	const fn = program.function(candidate.caller);
	if (editor.pendingEdits > 0) invalidateCoreReadAccessorLoopAnalysis(fn);
	const saved = candidate.readAccessorRegion;
	const planned =
		editor.pendingEdits === 0 &&
		saved?.bodyVersion === fn.version("body") &&
		saved.cfgVersion === fn.version("cfg") &&
		saved.exceptionFlowVersion === fn.version("exceptionFlow") &&
		saved.memoryEffectsVersion === fn.version("memoryEffects") &&
		[...saved.region.calls.values()].every(
			({ target, summary }) => summaries.summary(target)?.readAccessor === summary,
		)
			? saved
			: coreReadAccessorRegionCost(
					program,
					summaries,
					{ ...candidate, readAccessorRegion: undefined },
					hints,
					work,
				)?.plan;
	const region = planned?.region,
		loop = planned?.loop;
	if (
		region === undefined ||
		[...region.calls.values()].some(({ summary }) =>
			summary.reads.some(
				(read) => read.kind === "private" && !names.validSlot(read.slot),
			),
		)
	)
		return undefined;
	const original = region.instructions.map((instruction) => ({
		instruction,
		opcode: fn.instructionOpcodeName(instruction),
		inputs: operands(fn, instruction),
		outputs: results(fn, instruction),
		attributes: fn.instructionAttributes(instruction),
		refinement: fn.instructionEffectRefinement(instruction),
		position: fn.instructionSourcePosition(instruction),
	}));
	const included = new Set(region.instructions);
	const outputs = original
		.flatMap((operation) => operation.outputs)
		.filter((value) => {
			if (fn.kernel.valueHandlerUseCount(value) > 0) return true;
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (!included.has(fn.kernel.useInstruction(use))) return true;
			}
			return false;
		});
	const stateSpecs =
		loop === undefined
			? []
			: [
					{ representation: "boolean" as const },
					{ representation: "f64" as const },
					...loop.retainedPrefixes.map(() => ({ representation: "boxed" as const })),
				];
	const states = new Map<CoreBlockId, ReadonlyArray<CoreValueId>>();
	const outgoing = new Map<CoreBlockId, ReadonlyArray<CoreValueId>>();
	let initial: ReadonlyArray<CoreValueId> = [];
	if (loop !== undefined) {
		const preheader = loop.loop.preheader!;
		const empty = editor.appendInstruction(preheader, "createUndefined", []).outputs[0]!;
		const ready = editor.appendInstruction(preheader, "createBoolean", [], {
			attributes: { value: false },
			outputRepresentations: ["boolean"],
		}).outputs[0]!;
		const epoch = editor.appendInstruction(preheader, "createF64", [], {
			attributes: { value: 0 },
			outputRepresentations: ["f64"],
		}).outputs[0]!;
		initial = [ready, epoch, ...loop.retainedPrefixes.map(() => empty)];
		for (const block of loop.loop.blocks)
			states.set(block, editor.appendBlockParameters(block, stateSpecs));
	}
	const oldTerminator = coreTerminatorInput(fn, fn.blockTerminator(region.block));
	const fallback = editor.createBlock();
	let fast = editor.createBlock();
	const firstFast = fast;
	const fastBlocks: Array<CoreBlockId> = [fast];
	const join = editor.createBlock(
		outputs.map((value) => ({ representation: fn.valueRepresentation(value) })),
	);
	const joinStart = fn.kernel.blockParameterStart(join);
	const replacements = new Map(
		outputs.map((value, index) => [
			value,
			fn.kernel.blockParameterValue(joinStart + index),
		]),
	);
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(region.instructions.at(-1)!);
		next !== undefined && fn.instructionKind(next) === "operation";
		next = fn.instructionNext(next)
	)
		tail.push(next);
	for (const instruction of tail) editor.moveInstruction(instruction, join);
	editor.replaceValueUsesMany(replacements);
	editor.setTerminator(join, coreTerminatorInput(fn, fn.blockTerminator(region.block)));
	if (loop !== undefined)
		states.set(join, editor.appendBlockParameters(join, stateSpecs));
	const handlerBlock = fn.kernel.blockHandlerBlock(region.block);
	const handlerStart = fn.kernel.blockHandlerArgumentStart(region.block);
	const handlerArguments = Array.from(
		{ length: fn.kernel.blockHandlerArgumentCount(region.block) },
		(_, index) => fn.kernel.handlerArgumentAt(handlerStart + index),
	);
	let introduced = 0;
	const emitRegion = (reuse?: ReadonlyMap<string, CoreValueId>) => {
		const values = new Map<CoreValueId, CoreValueId>();
		// Prefix reuse ends before the terminal read, whose slow path can call user code.
		const admitted = new Map<CoreValueId, Map<string, CoreValueId>>();
		const guarded = new Set<string>();
		let position: number | undefined;
		const emittedPaths = new Map<CoreValueId, string>();
		const prefixValues = new Map<string, CoreValueId>();
		const pathOf = (value: CoreValueId) =>
			emittedPaths.get(value) ?? loop?.paths.get(value);
		const currentValue = (value: CoreValueId): CoreValueId => values.get(value) ?? value;
		const append = (
			opcode: string,
			inputs: ReadonlyArray<CoreValueId>,
			attributes = {},
			representations = ["boxed"] as ReadonlyArray<"boxed" | "boolean">,
		): ReadonlyArray<CoreValueId> => {
			introduced++;
			return editor.appendInstruction(fast, opcode, inputs, {
				attributes,
				sourcePosition: position,
				outputRepresentations: representations,
				outputCount: representations.length,
			}).outputs;
		};
		const check = (condition: CoreValueId): void => {
			const next = editor.createBlock();
			fastBlocks.push(next);
			editor.setTerminator(fast, {
				kind: "branch",
				condition,
				consequent: { block: next, arguments: [] },
				alternate: { block: fallback, arguments: [] },
			});
			fast = next;
		};
		let undefinedValue: CoreValueId | undefined;
		const undefinedConstant = (): CoreValueId =>
			(undefinedValue ??= append("createUndefined", [])[0]!);
		const probe = (
			receiver: CoreValueId,
			key: CoreValueId,
			readKind: "private" | "named" | "indexed",
			stringIndex = -1,
			privateSlot?: number,
		): CoreValueId => {
			const identity =
				readKind === "named"
					? `named:${stringIndex}`
					: readKind === "private" && privateSlot !== undefined
						? `private-slot:${privateSlot}`
						: `${readKind}:${key}`;
			const parent = pathOf(receiver);
			const prefix =
				readKind === "indexed" || parent === undefined
					? undefined
					: accessorPrefixKey(
							parent,
							readKind,
							readKind === "private" ? privateSlot! : stringIndex,
						);
			const reused = prefix === undefined ? undefined : reuse?.get(prefix);
			if (reused !== undefined) {
				emittedPaths.set(reused, prefix!);
				prefixValues.set(prefix!, reused);
				return reused;
			}
			const known = admitted.get(receiver)?.get(identity);
			if (known !== undefined) return known;
			const [value, success] = append(
				"probeRead",
				[receiver, key],
				{ readKind, ...(readKind === "named" ? { stringIndex } : {}) },
				["boxed", "boolean"],
			);
			check(success!);
			let reads = admitted.get(receiver);
			if (reads === undefined)
				admitted.set(receiver, (reads = new Map<string, CoreValueId>()));
			reads.set(identity, value!);
			if (prefix !== undefined) {
				emittedPaths.set(value!, prefix);
				prefixValues.set(prefix, value!);
			}
			return value!;
		};
		const completeIndexedRead = (receiver: CoreValueId, key: CoreValueId) => {
			const [value, success] = append(
				"probeRead",
				[receiver, key],
				{ readKind: "indexed" },
				["boxed", "boolean"],
			);
			const slow = editor.createBlock(),
				done = editor.createBlock([{}]);
			fastBlocks.push(slow, done);
			editor.setTerminator(fast, {
				kind: "branch",
				condition: success!,
				consequent: { block: done, arguments: [value!] },
				alternate: { block: slow, arguments: [] },
			});
			fast = slow;
			const loaded = append("loadProperty", [receiver, key])[0]!;
			editor.setTerminator(slow, {
				kind: "jump",
				edge: { block: done, arguments: [loaded] },
			});
			fast = done;
			return fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(done));
		};
		for (const operation of original) {
			position = operation.position;
			const call = region.calls.get(operation.instruction);
			if (call !== undefined) {
				const callee = currentValue(operation.inputs[0]!),
					receiver = currentValue(operation.inputs[1]!);
				const guard = `${callee}:${call.target}`;
				if (reuse === undefined && !guarded.has(guard)) {
					check(
						append("guardFunctionIndex", [callee], { functionIndex: call.target }, [
							"boolean",
						])[0]!,
					);
					guarded.add(guard);
				}
				let value = receiver;
				let reads = call.summary.reads;
				if (reuse !== undefined) {
					// The retained prefix ends at the indexed read; it and later reads run per iteration.
					const indexed = reads.findIndex((read) => read.kind === "indexed");
					let prefix = loop!.paths.get(operation.inputs[1]!)!;
					for (const read of reads.slice(0, indexed)) {
						if (read.kind === "indexed") throw new Error("Unexpected indexed prefix");
						prefix = accessorPrefixKey(
							prefix,
							read.kind,
							read.kind === "private" ? read.slot : read.stringIndex,
						);
					}
					value = reuse.get(prefix)!;
					if (value === undefined)
						throw new Error(`Missing retained accessor array ${prefix}`);
					reads = reads.slice(indexed);
				}
				for (const read of reads) {
					if (read.kind === "private") {
						const parent = pathOf(value);
						const prefix =
							parent === undefined
								? undefined
								: accessorPrefixKey(parent, "private", read.slot);
						const cached = prefix === undefined ? undefined : reuse?.get(prefix);
						if (cached !== undefined) {
							value = cached;
							emittedPaths.set(value, prefix!);
							prefixValues.set(prefix!, value);
						} else {
							const key = append("loadGlobal", [], { index: read.slot })[0]!;
							value = probe(value, key, "private", -1, read.slot);
						}
					} else if (read.kind === "named")
						value = probe(value, undefinedConstant(), "named", read.stringIndex);
					else {
						const key =
							operation.inputs[read.argument + 2] === undefined
								? undefinedConstant()
								: currentValue(operation.inputs[read.argument + 2]!);
						value =
							planned!.completeTerminalRead && read === reads.at(-1)
								? completeIndexedRead(value, key)
								: probe(value, key, "indexed");
					}
				}
				if (call.summary.defaultValue !== undefined) {
					const condition = append(
						"binary",
						[value, undefinedConstant()],
						{ operator: "==" },
						["boolean"],
					)[0]!;
					const present = editor.createBlock(),
						missing = editor.createBlock(),
						done = editor.createBlock([{}]);
					fastBlocks.push(present, missing, done);
					editor.setTerminator(fast, {
						kind: "branch",
						condition,
						consequent: { block: missing, arguments: [] },
						alternate: { block: present, arguments: [] },
					});
					editor.setTerminator(present, {
						kind: "jump",
						edge: { block: done, arguments: [value] },
					});
					fast = missing;
					const fallbackValue = call.summary.defaultValue;
					const replacement = append(
						fallbackValue.kind === "number"
							? "createNumber"
							: fallbackValue.kind === "null"
								? "createNull"
								: "createUndefined",
						[],
						fallbackValue.kind === "number" ? { value: fallbackValue.value } : {},
					)[0]!;
					editor.setTerminator(missing, {
						kind: "jump",
						edge: { block: done, arguments: [replacement] },
					});
					fast = done;
					value = fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(done));
				}
				values.set(operation.outputs[0]!, value);
			} else if (
				operation.opcode === "loadPropertyStatic" ||
				operation.opcode === "loadPrivate"
			) {
				if (reuse !== undefined) {
					const prefix = loop!.paths.get(operation.outputs[0]!);
					const value = prefix === undefined ? undefined : reuse.get(prefix);
					if (value !== undefined) values.set(operation.outputs[0]!, value);
					continue;
				}
				const receiver = currentValue(operation.inputs[0]!);
				const value =
					operation.opcode === "loadPrivate"
						? probe(
								receiver,
								currentValue(operation.inputs[1]!),
								"private",
								-1,
								names.keySlot(fn, operation.inputs[1]!),
							)
						: probe(
								receiver,
								undefinedConstant(),
								"named",
								operation.attributes.stringIndex as number,
							);
				values.set(operation.outputs[0]!, value);
				const path = loop?.paths.get(operation.outputs[0]!);
				if (path !== undefined) emittedPaths.set(value, path);
			} else {
				introduced++;
				const copied = editor.appendInstruction(
					fast,
					operation.opcode,
					operation.inputs.map(currentValue),
					{
						attributes: operation.attributes,
						sourcePosition: operation.position,
						outputCount: operation.outputs.length,
						outputRepresentations: operation.outputs.map((value) =>
							fn.valueRepresentation(value),
						),
					},
				);
				for (const [index, value] of operation.outputs.entries())
					values.set(value, copied.outputs[index]!);
			}
		}
		return { currentValue, prefixValues };
	};

	const normalStart = firstFast;
	let entry = normalStart;
	if (loop !== undefined) {
		entry = editor.createBlock();
		fastBlocks.push(entry);
		const epochCheck = editor.createBlock();
		fastBlocks.push(epochCheck);
		const cached = editor.createBlock();
		fastBlocks.push(cached);
		const input = states.get(region.block)!;
		const invalidBefore = [...fn.bodyInstructionIds(region.block)].some((instruction) =>
			loop.invalidators.has(instruction),
		);
		editor.setTerminator(entry, {
			kind: "branch",
			condition: invalidBefore ? initial[0]! : input[0]!,
			consequent: { block: epochCheck, arguments: [] },
			alternate: { block: normalStart, arguments: [] },
		});
		const matches = editor.appendInstruction(
			epochCheck,
			"guardServiceEpoch",
			[input[1]!],
			{ outputRepresentations: ["boolean"] },
		).outputs[0]!;
		editor.setTerminator(epochCheck, {
			kind: "branch",
			condition: matches,
			consequent: { block: cached, arguments: [] },
			alternate: { block: normalStart, arguments: [] },
		});
		fast = cached;
		const reused = emitRegion(
			new Map(
				loop.retainedPrefixes.map(
					(prefix, index) => [prefix, input[index + 2]!] as const,
				),
			),
		);
		outgoing.set(fast, input);
		editor.setTerminator(fast, {
			kind: "jump",
			edge: { block: join, arguments: outputs.map(reused.currentValue) },
		});
		fast = normalStart;
		for (const value of loop.numericGuards) {
			const condition = editor.appendInstruction(fast, "typeofCompare", [value], {
				attributes: { expected: "number", negated: false },
				outputRepresentations: ["boolean"],
			}).outputs[0]!;
			const next = editor.createBlock();
			fastBlocks.push(next);
			editor.setTerminator(fast, {
				kind: "branch",
				condition,
				consequent: { block: next, arguments: [] },
				alternate: { block: fallback, arguments: [] },
			});
			fast = next;
		}
	}
	const admittedRegion = emitRegion();
	if (loop !== undefined) {
		const ready = editor.appendInstruction(fast, "createBoolean", [], {
			attributes: { value: true },
			outputRepresentations: ["boolean"],
		}).outputs[0]!;
		introduced++;
		const epoch = editor.appendInstruction(fast, "readServiceEpoch", [], {
			outputRepresentations: ["f64"],
		}).outputs[0]!;
		outgoing.set(fast, [
			ready,
			epoch,
			...loop.retainedPrefixes.map((prefix) => {
				const value = admittedRegion.prefixValues.get(prefix);
				if (value === undefined)
					throw new Error(`Missing retained accessor prefix ${prefix}`);
				return value;
			}),
		]);
		outgoing.set(fallback, initial);
	}
	editor.setTerminator(fast, {
		kind: "jump",
		edge: { block: join, arguments: outputs.map(admittedRegion.currentValue) },
	});
	for (const operation of original) {
		const call = region.calls.get(operation.instruction);
		editor.replaceInstruction(operation.instruction, operation.opcode, operation.inputs, {
			attributes: {
				...operation.attributes,
				...(call === undefined ? {} : { [CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]: true }),
			},
			sourcePosition: operation.position,
			...(operation.refinement === undefined
				? {}
				: { effectRefinement: operation.refinement }),
		});
		editor.moveInstruction(operation.instruction, fallback);
	}
	editor.setTerminator(fallback, {
		kind: "jump",
		edge: { block: join, arguments: outputs },
	});
	editor.replaceTerminator(region.block, {
		kind: "jump",
		edge: { block: entry, arguments: [] },
		sourcePosition: oldTerminator.sourcePosition,
	});
	if (loop !== undefined) {
		for (const block of new Set([...states.keys(), ...outgoing.keys()])) {
			const state = outgoing.get(block) ?? states.get(block)!;
			const invalidated = [...fn.bodyInstructionIds(block)].some((instruction) =>
				loop.invalidators.has(instruction),
			);
			const exitState = invalidated ? initial : state;
			editor.replaceTerminator(
				block,
				mapCoreTerminatorEdges(
					coreTerminatorInput(fn, fn.blockTerminator(block)),
					(edge) =>
						states.has(edge.block)
							? { ...edge, arguments: [...edge.arguments, ...exitState] }
							: edge,
				),
			);
		}
		const preheader = loop.loop.preheader!;
		editor.replaceTerminator(
			preheader,
			mapCoreTerminatorEdges(
				coreTerminatorInput(fn, fn.blockTerminator(preheader)),
				(edge) =>
					states.has(edge.block)
						? { ...edge, arguments: [...edge.arguments, ...initial] }
						: edge,
			),
		);
	}

	if (handlerBlock !== undefined) {
		for (const block of [join, fallback, ...fastBlocks])
			editor.setHandler(block, handlerBlock, handlerArguments);
	}
	if (work !== undefined) {
		work.accessorRegionsApplied++;
		if (loop !== undefined) {
			work.accessorLoopRegionsApplied++;
			work.accessorLoopApplications?.push({
				caller: fn.id,
				name: String.fromCodePoint(
					...(program.stringConstants[fn.metadata.nameStringIndex] ?? []),
				),
				site: candidate.site,
				header: loop.loop.header,
				prefixes: loop.prefixes,
				retainedPrefixes: loop.retainedPrefixes,
				numericGuards: loop.numericGuards,
				invalidations: [...loop.invalidators],
			});
		}
		work.accessorApplications?.push({
			caller: fn.id,
			name: String.fromCodePoint(
				...(program.stringConstants[fn.metadata.nameStringIndex] ?? []),
			),
			site: candidate.site,
		});
	}
	return { instructionsIntroduced: introduced, blocksIntroduced: fastBlocks.length + 2 };
}
