import type { ConstructedCoreCompilation } from "./core-compilation.ts";
import { CoreEditor } from "./core-editor.ts";
import { coreAccessorHints } from "./core-instance-method-hints.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreValueId,
} from "./core-ir.ts";
import { coreReadAccessorSummary } from "./core-read-accessors.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface AccessorSite {
	readonly instruction: CoreInstructionId;
	readonly target: CoreFunctionId;
	readonly setter: boolean;
}

function accessorSites(
	program: CoreProgram,
	fn: CoreFunctionStore,
	hints: ReturnType<typeof coreAccessorHints>,
	accessible: (target: CoreFunctionId) => boolean,
): Array<AccessorSite> {
	const sites: Array<AccessorSite> = [];
	let loopBlocks: Set<CoreBlockId> | undefined;
	for (const instruction of fn.instructionIds()) {
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") continue;
		const opcode = header.opcode;
		if (opcode !== "loadPropertyStatic" && opcode !== "storePropertyStatic") continue;
		// Outside loops an accessor call costs less than the code its probe adds.
		loopBlocks ??= new Set(
			buildCoreControlFlow(program, fn.id).loops.flatMap((loop) => [...loop.blocks]),
		);
		if (!loopBlocks.has(fn.instructionBlock(instruction))) continue;
		const setter = opcode === "storePropertyStatic";
		const attributes = fn.instructionAttributes(instruction);
		const stringIndex = attributes.stringIndex;
		const targets =
			typeof stringIndex === "number" && !hints.ordinary.has(stringIndex)
				? (setter ? hints.setters : hints.getters).get(stringIndex)
				: undefined;
		if (
			targets?.length !== 1 ||
			!accessible(targets[0]!) ||
			attributes[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE] === true ||
			attributes.knownOwnSlot !== undefined ||
			fn.instructionEffectRefinement(instruction) !== undefined ||
			fn.instructionKind(fn.blockTerminator(fn.instructionBlock(instruction))) ===
				"guard" ||
			(!setter &&
				fn.valueRepresentation(
					fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				) !== "boxed")
		)
			continue;
		sites.push({ instruction, target: targets[0]!, setter });
	}
	return sites;
}

/**
 * Splits a static access into a probe for the class accessor its name hints at:
 * a hit calls that accessor with the receiver, as [[Get]] and [[Set]] would, and
 * the call's hinted target lets the cross-call transforms inline it; a miss runs
 * the original access unchanged.
 */
function exposeAccessorSite(
	fn: CoreFunctionStore,
	editor: CoreEditor,
	site: AccessorSite,
) {
	const { instruction } = site;
	const block = fn.instructionBlock(instruction);
	const originalTerminator = fn.blockTerminator(block);
	const sourcePosition = fn.instructionSourcePosition(instruction);
	const operandStart = fn.kernel.instructionOperandStart(instruction);
	const receiver = fn.kernel.operandAt(operandStart);
	const stored = site.setter ? fn.kernel.operandAt(operandStart + 1) : undefined;
	const result = site.setter
		? undefined
		: fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(instruction);
		next !== undefined && next !== originalTerminator;
		next = fn.instructionNext(next)
	)
		tail.push(next);
	const call = editor.createBlock();
	const fallback = editor.createBlock();
	const join = editor.createBlock(
		result === undefined ? [] : [{ representation: "boxed" }],
	);
	const handler = fn.kernel.blockHandlerBlock(block);
	if (handler !== undefined) {
		const start = fn.kernel.blockHandlerArgumentStart(block);
		const args = Array.from(
			{ length: fn.kernel.blockHandlerArgumentCount(block) },
			(_, index) => fn.kernel.handlerArgumentAt(start + index),
		);
		for (const created of [call, fallback, join])
			editor.setHandler(created, handler, args);
	}
	for (const moved of tail) editor.moveInstruction(moved, join);
	const joined: Array<CoreValueId> = [];
	if (result !== undefined) {
		joined.push(fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(join)));
		editor.replaceValueUses(result, joined[0]!);
	}
	editor.setTerminator(join, {
		...coreTerminatorInput(fn, originalTerminator),
		sourcePosition: fn.instructionSourcePosition(originalTerminator),
	});
	editor.removeInstruction(originalTerminator);
	editor.moveInstruction(instruction, fallback);
	editor.replaceInstruction(
		instruction,
		fn.instructionOpcodeName(instruction),
		site.setter ? [receiver, stored!] : [receiver],
		{
			attributes: {
				...fn.instructionAttributes(instruction),
				[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]: true,
			},
			sourcePosition,
		},
	);
	editor.setTerminator(fallback, {
		kind: "jump",
		edge: { block: join, arguments: result === undefined ? [] : [result] },
		sourcePosition,
	});
	const key = editor.appendInstruction(block, "createUndefined", [], { sourcePosition })
		.outputs[0]!;
	const [accessor, found] = editor.appendInstruction(
		block,
		"probeRead",
		[receiver, key],
		{
			attributes: {
				readKind: site.setter ? "setter" : "getter",
				stringIndex: fn.instructionAttributes(instruction).stringIndex as number,
				functionIndex: site.target,
			},
			outputRepresentations: ["boxed", "boolean"],
			sourcePosition,
		},
	).outputs;
	editor.setTerminator(block, {
		kind: "branch",
		condition: found!,
		consequent: { block: call, arguments: [] },
		alternate: { block: fallback, arguments: [] },
		sourcePosition,
	});
	const value = editor.appendInstruction(
		call,
		"call",
		site.setter ? [accessor!, receiver, stored!] : [accessor!, receiver],
		{ outputRepresentations: ["boxed"], sourcePosition },
	).outputs[0]!;
	editor.setTerminator(call, {
		kind: "jump",
		edge: { block: join, arguments: result === undefined ? [] : [value] },
		sourcePosition,
	});
}

/**
 * Class accessors run through each access site's rooted miss path and a generic
 * call. Where exactly one class defines an accessor for a static name, expose
 * that call so later transforms can bind and inline it.
 */
export function exposeCoreAccessorCalls(compilation: ConstructedCoreCompilation): number {
	const program = compilation.program;
	const hints = coreAccessorHints(program);
	if (hints.getters.size === 0 && hints.setters.size === 0) return 0;
	// Only accessors small enough for the later expansion repay the probe at every site.
	const small = new Map<CoreFunctionId, boolean>();
	const accessible = (target: CoreFunctionId): boolean => {
		let admitted = small.get(target);
		if (admitted === undefined) {
			const accessor = program.function(target);
			const cfg = buildCoreControlFlow(program, target);
			admitted =
				coreReadAccessorSummary(accessor, cfg) !== undefined ||
				(accessor.parameterCount === 1 &&
					cfg.reachable.size <= 2 &&
					cfg.loops.length === 0 &&
					[...accessor.instructionIds()].length <= 12);
			small.set(target, admitted);
		}
		return admitted;
	};
	let exposed = 0;
	for (const functionId of program.functionIds()) {
		const fn = program.function(functionId);
		const sites = accessorSites(program, fn, hints, accessible);
		if (sites.length === 0) continue;
		const editor = CoreEditor.open(program, functionId);
		for (const site of sites) exposeAccessorSite(fn, editor, site);
		editor.commit();
		exposed += sites.length;
	}
	return exposed;
}
