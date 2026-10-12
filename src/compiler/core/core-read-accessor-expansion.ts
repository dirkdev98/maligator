import type { ReadAccessorSummary } from "../shared/effect-summary.ts";
import type { CoreEditor } from "./core-editor.ts";
import { coreInstanceMethodHint } from "./core-instance-method-hints.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { coreTerminatorInput } from "./core-ir-control-flow.ts";
import { coreInstructionEffects } from "./core-ir-opcodes.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import type { CoreModulePrivateNameIndex } from "./core-private-names.ts";
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

interface ReadRegion {
	readonly block: CoreBlockId;
	readonly instructions: ReadonlyArray<CoreInstructionId>;
	readonly calls: ReadonlyMap<CoreInstructionId, AccessorCall>;
}

export interface CoreReadAccessorRegionPlan {
	readonly bodyVersion: number;
	readonly cfgVersion: number;
	readonly memoryEffectsVersion: number;
	readonly region: ReadRegion;
}

export interface CoreReadAccessorWork {
	accessorRegionDiscoveries: number;
	accessorInstructionVisits: number;
	accessorPlansReused: number;
	accessorRegionsOffered: number;
	accessorRegionsApplied: number;
	accessorApplications?: Array<{ caller: number; name: string; site: number }>;
}

export const EMPTY_CORE_READ_ACCESSOR_WORK: Readonly<CoreReadAccessorWork> =
	Object.freeze({
		accessorRegionDiscoveries: 0,
		accessorInstructionVisits: 0,
		accessorPlansReused: 0,
		accessorRegionsOffered: 0,
		accessorRegionsApplied: 0,
	});

type ReadAccessorAnchor = Pick<
	CoreTransformCandidate,
	"caller" | "site" | "targets" | "readAccessorRegion"
>;

function regionInstruction(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): boolean {
	const opcode = fn.instructionOpcodeName(instruction);
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
	hints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
	reusePlan = true,
	work?: CoreReadAccessorWork,
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
			output.length === 1 &&
			fn.valueRepresentation(output[0]!) === "boxed"
			? { target, summary }
			: undefined;
	};
	let start = candidate.site;
	for (let count = 0; count < 12; count++) {
		const previous = fn.instructionPrevious(start);
		if (work !== undefined && previous !== undefined) work.accessorInstructionVisits++;
		if (
			previous === undefined ||
			fn.instructionKind(previous) !== "operation" ||
			(!regionInstruction(fn, previous) && accessorCall(previous) === undefined)
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
			if (!regionInstruction(fn, instruction)) break;
			instructions.push(instruction);
			continue;
		}
		const call = accessorCall(instruction);
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
	hints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
	work?: CoreReadAccessorWork,
):
	| {
			generatedCode: number;
			compilerWork: number;
			sites: ReadonlyArray<CoreInstructionId>;
			plan: CoreReadAccessorRegionPlan;
	  }
	| undefined {
	const region = readRegion(program, summaries, candidate, hints, true, work);
	if (region === undefined) return undefined;
	// A single field read has no sharing benefit and retains the ordinary inline fast path.
	if (
		region.calls.size === 1 &&
		region.calls.values().next().value!.summary.reads.length === 1
	)
		return undefined;
	const generatedCode =
		region.instructions.length * 2 +
		[...region.calls.values()].reduce(
			(cost, { summary }) =>
				cost +
				2 +
				summary.reads.length * 3 +
				(summary.defaultValue === undefined ? 0 : 5),
			0,
		);
	const fn = program.function(candidate.caller);
	return {
		generatedCode,
		compilerWork: generatedCode * 2 + region.instructions.length,
		sites: [...region.calls.keys()],
		plan: {
			bodyVersion: fn.version("body"),
			cfgVersion: fn.version("cfg"),
			memoryEffectsVersion: fn.version("memoryEffects"),
			region,
		},
	};
}

export function expandCoreReadAccessorRegion(
	program: CoreProgram,
	summaries: CoreProgramSummaries,
	names: CoreModulePrivateNameIndex,
	candidate: CoreTransformCandidate,
	editor: CoreEditor,
	hints: ReadonlyMap<number, ReadonlyArray<CoreFunctionId>>,
	work?: CoreReadAccessorWork,
): { instructionsIntroduced: number; blocksIntroduced: number } | undefined {
	const fn = program.function(candidate.caller),
		// Store versions advance on commit, so an open edit batch invalidates its plans.
		region = readRegion(
			program,
			summaries,
			candidate,
			hints,
			editor.pendingEdits === 0,
			work,
		);
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
	const handlerBlock = fn.kernel.blockHandlerBlock(region.block);
	const handlerStart = fn.kernel.blockHandlerArgumentStart(region.block);
	const handlerArguments = Array.from(
		{ length: fn.kernel.blockHandlerArgumentCount(region.block) },
		(_, index) => fn.kernel.handlerArgumentAt(handlerStart + index),
	);
	const values = new Map<CoreValueId, CoreValueId>();
	let introduced = 0;
	let position: number | undefined;
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
	): CoreValueId => {
		const [value, success] = append(
			"probeRead",
			[receiver, key],
			{ readKind, ...(readKind === "named" ? { stringIndex } : {}) },
			["boxed", "boolean"],
		);
		check(success!);
		return value!;
	};
	for (const operation of original) {
		position = operation.position;
		const call = region.calls.get(operation.instruction);
		if (call !== undefined) {
			const callee = currentValue(operation.inputs[0]!),
				receiver = currentValue(operation.inputs[1]!);
			check(
				append("guardFunctionIndex", [callee], { functionIndex: call.target }, [
					"boolean",
				])[0]!,
			);
			let value = receiver;
			for (const read of call.summary.reads) {
				if (read.kind === "private") {
					const key = append("loadGlobal", [], { index: read.slot })[0]!;
					value = probe(value, key, "private");
				} else if (read.kind === "named")
					value = probe(value, undefinedConstant(), "named", read.stringIndex);
				else
					value = probe(
						value,
						operation.inputs[read.argument + 2] === undefined
							? undefinedConstant()
							: currentValue(operation.inputs[read.argument + 2]!),
						"indexed",
					);
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
			const receiver = currentValue(operation.inputs[0]!);
			const value =
				operation.opcode === "loadPrivate"
					? probe(receiver, currentValue(operation.inputs[1]!), "private")
					: probe(
							receiver,
							undefinedConstant(),
							"named",
							operation.attributes.stringIndex as number,
						);
			values.set(operation.outputs[0]!, value);
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
	editor.setTerminator(fast, {
		kind: "jump",
		edge: { block: join, arguments: outputs.map(currentValue) },
	});
	editor.setTerminator(fallback, {
		kind: "jump",
		edge: { block: join, arguments: outputs },
	});
	editor.replaceTerminator(region.block, {
		kind: "jump",
		edge: { block: firstFast, arguments: [] },
		sourcePosition: oldTerminator.sourcePosition,
	});
	if (handlerBlock !== undefined) {
		for (const block of [join, fallback, ...fastBlocks])
			editor.setHandler(block, handlerBlock, handlerArguments);
	}
	if (work !== undefined) {
		work.accessorRegionsApplied++;
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
