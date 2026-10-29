import { evaluateConstantBuiltin } from "../shared/constant-builtins.ts";
import type { StaticMember } from "../shared/static-values.ts";
import type { CoreAnalysisManager } from "./core-analysis-manager.ts";
import { coreCalleeTargetsAreOpen } from "./core-callee-targets.ts";
import { CoreEditor } from "./core-editor.ts";
import {
	coreInstanceMethodHint,
	coreInstanceMethodHints,
} from "./core-instance-method-hints.ts";
import { CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE } from "./core-internal-attributes.ts";
import { buildCoreControlFlow, coreTerminatorInput } from "./core-ir-control-flow.ts";
import type { CoreProgramSummaries } from "./core-ir-summaries.ts";
import type {
	CoreBlockId,
	CoreFunctionId,
	CoreInstructionId,
	CoreTerminatorInput,
	CoreValueId,
} from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { coreReadAccessorSummary } from "./core-read-accessors.ts";
import { coreStaticMemberOperation } from "./core-static-value-selection.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import type { CoreStaticValue, CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";
import type {
	CoreTransformBudgetLimits,
	CoreTransformCandidate,
	CoreTransformCandidateService,
} from "./core-transform-candidates.ts";

type StaticSearchMethod = "includes" | "indexOf" | "lastIndexOf";

interface StaticSearchPlan {
	readonly method: StaticSearchMethod;
	readonly search?: CoreValueId;
	readonly elements: ReadonlyArray<{
		readonly index: number;
		readonly operation: CoreStaticMemberOperation;
	}>;
}

interface StaticParameterPlan {
	readonly kind: "collection" | "literal-key";
	readonly parameter: number;
	readonly replacements: ReadonlyMap<CoreInstructionId, CoreStaticMemberOperation>;
	readonly searches: ReadonlyMap<CoreInstructionId, StaticSearchPlan>;
	readonly blocks: ReadonlyArray<CoreBlockId>;
	readonly cost: number;
}

function inputs(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
): Array<CoreValueId> {
	const start = fn.kernel.instructionOperandStart(instruction);
	return Array.from(
		{ length: fn.kernel.instructionOperandCount(instruction) },
		(_, index) => fn.kernel.operandAt(start + index),
	);
}
function result(fn: CoreFunctionStore, instruction: CoreInstructionId): CoreValueId {
	return fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction));
}

function staticSearchStart(
	program: CoreProgram,
	fn: CoreFunctionStore,
	method: StaticSearchMethod,
	length: number,
	value: CoreValueId | undefined,
): number | undefined {
	// Empty searches return before coercing an explicitly supplied offset.
	if (length === 0) return method === "lastIndexOf" ? -1 : 0;
	if (value === undefined) return method === "lastIndexOf" ? length - 1 : 0;
	// The collection proof belongs to the caller; helper SSA IDs need local definitions.
	for (let depth = 0; depth < 32; depth++) {
		if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
		const instruction = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
		const header = fn.instructionHeader(instruction);
		if (typeof header === "string") return undefined;
		const opcode = header.opcode;
		if (opcode === "move") {
			value = inputs(fn, instruction)[0]!;
			continue;
		}
		if (opcode === "createUndefined" || opcode === "createNull") return 0;
		const attribute = fn.instructionAttributes(instruction).value;
		let constant: number;
		if (opcode === "createBoolean") {
			if (typeof attribute !== "boolean") return undefined;
			constant = attribute ? 1 : 0;
		} else if (opcode === "createString") {
			const stringIndex = fn.instructionAttributes(instruction).stringIndex;
			if (typeof stringIndex !== "number") return undefined;
			const units = program.stringConstants[stringIndex];
			if (units === undefined || units.length > 4096) return undefined;
			const converted = evaluateConstantBuiltin("Number", undefined, [
				{ kind: "string", value: String.fromCharCode(...units) },
			]);
			if (converted.kind !== "value" || converted.value.kind !== "number")
				return undefined;
			constant = converted.value.value;
		} else if (
			opcode === "createNumber" ||
			opcode === "createF64" ||
			opcode === "createI32"
		) {
			if (typeof attribute !== "number") return undefined;
			constant = attribute;
		} else return undefined;
		const integer = Number.isNaN(constant) ? 0 : Math.trunc(constant);
		return method === "lastIndexOf"
			? integer >= 0
				? Math.min(integer, length - 1)
				: length + integer
			: integer >= 0
				? integer
				: Math.max(length + integer, 0);
	}
	return undefined;
}

function staticParameterPlan(
	program: CoreProgram,
	fn: CoreFunctionStore,
	parameter: number,
	fact: CoreStaticValue,
	analysis: CoreStaticValueAnalysis,
): StaticParameterPlan | undefined {
	if (
		fn.isAsync ||
		fn.isGenerator ||
		fn.metadata.capturedCount !== 0 ||
		fn.metadata.mappedArguments ||
		fn.metadata.isClassConstructor ||
		fn.liveStorageCounts().instructions > 256
	)
		return undefined;
	const description = program.staticDescriptions.description(fact.description);
	if (description.kind === "string") {
		const stringIndex = program.stringConstantSlot(description.codeUnits, "first");
		if (stringIndex === undefined) return undefined;
		const control = buildCoreControlFlow(program, fn.id);
		const summary = coreReadAccessorSummary(fn, control);
		if (
			!summary?.reads.some(
				(read) => read.kind === "indexed" && read.argument === parameter,
			)
		)
			return undefined;
		const key = fn.kernel.functionParameter(parameter);
		const replacements = new Map<CoreInstructionId, CoreStaticMemberOperation>();
		for (const block of control.reversePostorder) {
			for (const instruction of fn.bodyInstructionIds(block)) {
				const args = inputs(fn, instruction);
				if (fn.instructionOpcodeName(instruction) === "loadProperty" && args[1] === key) {
					replacements.set(instruction, {
						opcode: "loadPropertyStatic",
						inputs: [args[0]!],
						attributes: { stringIndex },
					});
				} else if (args.includes(key)) return undefined;
			}
		}
		return {
			kind: "literal-key",
			parameter,
			replacements,
			searches: new Map(),
			blocks: control.reversePostorder,
			cost: fn.liveStorageCounts().instructions,
		};
	}
	if (
		(description.kind !== "array" && description.kind !== "object") ||
		description.ownKeysComplete === false ||
		!fact.privateUntilObservation ||
		fact.operands.length !== 0
	)
		return undefined;
	const control = buildCoreControlFlow(program, fn.id);
	if (control.loops.length !== 0 || control.irreducibleCycles.length !== 0)
		return undefined;
	const replacements = new Map<CoreInstructionId, CoreStaticMemberOperation>();
	const searches = new Map<CoreInstructionId, StaticSearchPlan>();
	const aliases = new Set<CoreValueId>([fn.kernel.functionParameter(parameter)]),
		methods = new Map<CoreValueId, StaticSearchMethod>();
	let cost = fn.liveStorageCounts().instructions;
	for (const block of control.reversePostorder) {
		if (
			fn.kernel.blockHandlerBlock(block) !== undefined ||
			!["return", "jump", "branch"].includes(
				fn.instructionKind(fn.blockTerminator(block)),
			)
		)
			return undefined;
		for (const instruction of fn.bodyInstructionIds(block)) {
			const opcode = fn.instructionOpcodeName(instruction),
				args = inputs(fn, instruction);
			if (
				[
					"loadCaptured",
					"storeCaptured",
					"loadThis",
					"loadCallee",
					"loadNewTarget",
					"loadArgument",
					"loadArgumentCount",
					"loadStaticArgument",
					"createArgumentsObject",
					"createRestArguments",
					"createFunction",
					"eval",
				].includes(opcode)
			)
				return undefined;
			if (opcode === "move" && aliases.has(args[0]!)) {
				aliases.add(result(fn, instruction));
				replacements.set(instruction, { opcode: "createUndefined", inputs: [] });
				continue;
			}
			if (opcode === "move" && methods.has(args[0]!)) {
				methods.set(result(fn, instruction), methods.get(args[0]!)!);
				replacements.set(instruction, { opcode: "createUndefined", inputs: [] });
				continue;
			}
			if (opcode === "loadPropertyStatic" && aliases.has(args[0]!)) {
				const key = analysis.string(
					fn.instructionAttributes(instruction).stringIndex as number,
				);
				const property = description.properties.find((property) => property.key === key);
				if (property?.descriptor.kind === "data") {
					const operation = coreStaticMemberOperation(
						program,
						property.descriptor.value,
						[],
					);
					if (operation === undefined) return undefined;
					replacements.set(instruction, operation);
					continue;
				}
				if (
					description.kind === "array" &&
					key === "length" &&
					description.length !== null
				) {
					replacements.set(instruction, {
						opcode: "createNumber",
						inputs: [],
						attributes: { value: description.length },
					});
					continue;
				}
				const proof = analysis.inherited(fact, key);
				const method = (["includes", "indexOf", "lastIndexOf"] as const).find(
					(method) => proof?.resolution?.value?.[0] === `Array.prototype.${method}`,
				);
				if (method !== undefined) {
					methods.set(result(fn, instruction), method);
					replacements.set(instruction, { opcode: "createUndefined", inputs: [] });
					continue;
				}
				return undefined;
			}
			if (
				opcode === "call" &&
				methods.has(args[0]!) &&
				aliases.has(args[1]!) &&
				args.length <= 4 &&
				description.kind === "array" &&
				description.length !== null &&
				description.length <= 64
			) {
				const method = methods.get(args[0]!)!;
				// Erased receiver/method aliases cannot stand in for an observed search identity.
				if (
					description.length > 0 &&
					args[2] !== undefined &&
					(aliases.has(args[2]) || methods.has(args[2]))
				)
					return undefined;
				const start = staticSearchStart(program, fn, method, description.length, args[3]);
				if (start === undefined) return undefined;
				const elements: Array<StaticSearchPlan["elements"][number]> = [];
				for (let index = 0; index < description.length; index++) {
					if (method === "lastIndexOf" ? index > start : index < start) continue;
					const property = description.properties.find(
						(property) => property.key === String(index),
					);
					let member: StaticMember;
					if (property === undefined) {
						if (analysis.inherited(fact, String(index))?.kind !== "absent")
							return undefined;
						if (method !== "includes") continue;
						member = {
							kind: "constant",
							description: program.staticDescriptions.intern({ kind: "undefined" }),
						};
					} else {
						if (property.descriptor.kind !== "data") return undefined;
						member = property.descriptor.value;
					}
					const operation = coreStaticMemberOperation(program, member, []);
					if (operation === undefined) return undefined;
					elements.push({ index, operation });
				}
				if (method === "lastIndexOf") elements.reverse();
				searches.set(instruction, { method, search: args[2], elements });
				cost += elements.length * 4 + 3;
				continue;
			}
			if (args.some((input) => aliases.has(input) || methods.has(input)))
				return undefined;
			const effects = fn.registry.byId(fn.instructionOpcode(instruction)).effects;
			// A sloppy callback can expose its caller's function identity.
			if (
				!fn.metadata.strict &&
				effects.callsUserCode &&
				!(
					opcode === "binary" &&
					["===", "!=="].includes(
						fn.instructionAttributes(instruction).operator as string,
					)
				) &&
				!(
					opcode === "unary" &&
					fn.instructionAttributes(instruction).operator === "typeof"
				)
			)
				return undefined;
		}
		const terminator = fn.blockTerminator(block);
		if (inputs(fn, terminator).some((input) => aliases.has(input) || methods.has(input)))
			return undefined;
	}
	if (replacements.size === 0) return undefined;
	return {
		kind: "collection",
		parameter,
		replacements,
		searches,
		blocks: control.reversePostorder,
		cost,
	};
}

function cloneWithStaticParameter(
	program: CoreProgram,
	target: CoreFunctionStore,
	plan: StaticParameterPlan,
): CoreFunctionId {
	const editor = CoreEditor.createFunction(program, {
		parameterCount: target.parameterCount,
		metadata: target.metadata,
	});
	const blocks = new Map<CoreBlockId, CoreBlockId>(),
		values = new Map<CoreValueId, CoreValueId>();
	for (const block of plan.blocks) {
		const parameters = Array.from(
			{ length: target.kernel.blockParameterCount(block) },
			(_, index) =>
				target.kernel.blockParameterValue(
					target.kernel.blockParameterStart(block) + index,
				),
		);
		const created = editor.createBlock(
			parameters.map((value) => ({ representation: target.valueRepresentation(value) })),
		);
		blocks.set(block, created);
		parameters.forEach((value, index) =>
			values.set(
				value,
				editor.function.kernel.blockParameterValue(
					editor.function.kernel.blockParameterStart(created) + index,
				),
			),
		);
	}
	const map = (value: CoreValueId): CoreValueId => {
		const mapped = values.get(value);
		if (mapped === undefined)
			throw Error("Static specialization has an unmapped operand");
		return mapped;
	};
	for (const block of plan.blocks) {
		let outputBlock = blocks.get(block)!;
		const append = (
			opcode: string,
			args: ReadonlyArray<CoreValueId>,
			attributes?: CoreStaticMemberOperation["attributes"],
		) => editor.appendInstruction(outputBlock, opcode, args, { attributes }).outputs[0]!;
		for (const instruction of target.bodyInstructionIds(block)) {
			const replacement = plan.replacements.get(instruction),
				searchPlan = plan.searches.get(instruction);
			if (replacement !== undefined) {
				values.set(
					result(target, instruction),
					append(replacement.opcode, replacement.inputs.map(map), replacement.attributes),
				);
				continue;
			}
			if (searchPlan !== undefined && searchPlan.method !== "includes") {
				const search =
					searchPlan.search === undefined
						? append("createUndefined", [])
						: map(searchPlan.search);
				const continuation = editor.createBlock([{}]);
				for (const { index, operation } of searchPlan.elements) {
					const constant = append(
						operation.opcode,
						operation.inputs,
						operation.attributes,
					);
					const equal = append("binary", [search, constant], { operator: "===" });
					const found = append("createNumber", [], { value: index });
					const next = editor.createBlock();
					editor.setTerminator(outputBlock, {
						kind: "branch",
						condition: equal,
						consequent: { block: continuation, arguments: [found] },
						alternate: { block: next, arguments: [] },
					});
					outputBlock = next;
				}
				const absent = append("createNumber", [], { value: -1 });
				editor.setTerminator(outputBlock, {
					kind: "jump",
					edge: { block: continuation, arguments: [absent] },
				});
				outputBlock = continuation;
				values.set(
					result(target, instruction),
					editor.function.kernel.blockParameterValue(
						editor.function.kernel.blockParameterStart(continuation),
					),
				);
				continue;
			}
			if (searchPlan !== undefined) {
				const search =
					searchPlan.search === undefined
						? append("createUndefined", [])
						: map(searchPlan.search);
				let accumulated = append("createNumber", [], { value: 0 });
				for (const { operation: element } of searchPlan.elements) {
					const constant = append(element.opcode, element.inputs, element.attributes);
					const nan =
						(element.opcode === "createNumber" || element.opcode === "createF64") &&
						typeof element.attributes?.value === "number" &&
						Number.isNaN(element.attributes.value);
					const equal = append("binary", nan ? [search, search] : [search, constant], {
						operator: nan ? "!==" : "===",
					});
					accumulated = append("binary", [accumulated, equal], { operator: "|" });
				}
				const zero = append("createNumber", [], { value: 0 });
				values.set(
					result(target, instruction),
					append("binary", [accumulated, zero], { operator: "!==" }),
				);
				continue;
			}
			const created = editor.appendInstruction(
				outputBlock,
				target.instructionOpcodeName(instruction),
				inputs(target, instruction).map(map),
				{
					attributes: target.instructionAttributes(instruction),
					sourcePosition: target.instructionSourcePosition(instruction),
					outputCount: target.kernel.instructionResultCount(instruction),
					outputRepresentations: Array.from(
						{ length: target.kernel.instructionResultCount(instruction) },
						(_, index) =>
							target.valueRepresentation(
								target.kernel.resultAt(
									target.kernel.instructionResultStart(instruction) + index,
								),
							),
					),
				},
			);
			created.outputs.forEach((output, index) =>
				values.set(
					target.kernel.resultAt(
						target.kernel.instructionResultStart(instruction) + index,
					),
					output,
				),
			);
		}
		const original = coreTerminatorInput(target, target.blockTerminator(block));
		const edge = (input: {
			block: CoreBlockId;
			arguments: ReadonlyArray<CoreValueId>;
		}) => ({ block: blocks.get(input.block)!, arguments: input.arguments.map(map) });
		const terminator: CoreTerminatorInput =
			original.kind === "return"
				? { kind: "return", value: map(original.value) }
				: original.kind === "jump"
					? { kind: "jump", edge: edge(original.edge) }
					: original.kind === "branch"
						? {
								kind: "branch",
								condition: map(original.condition),
								consequent: edge(original.consequent),
								alternate: edge(original.alternate),
							}
						: { kind: "unreachable" };
		editor.setTerminator(outputBlock, terminator);
	}
	editor.finishFunction(
		blocks.get(target.entry)!,
		target.bodyEntry === undefined ? undefined : blocks.get(target.bodyEntry),
	);
	editor.commit();
	return editor.function.id;
}

function guardStaticAccessorCall(
	program: CoreProgram,
	caller: CoreFunctionId,
	site: CoreInstructionId,
	target: CoreFunctionId,
	variant: CoreFunctionId,
	parameter: number,
): void {
	const fn = program.function(caller),
		editor = CoreEditor.open(program, caller);
	const block = fn.instructionBlock(site),
		terminator = fn.blockTerminator(block);
	const position = fn.instructionSourcePosition(site),
		args = inputs(fn, site);
	const output = result(fn, site),
		representation = fn.valueRepresentation(output);
	const fast = editor.createBlock(),
		fallback = editor.createBlock();
	const join = editor.createBlock([{ representation }]);
	const joined = fn.kernel.blockParameterValue(fn.kernel.blockParameterStart(join));
	const tail: Array<CoreInstructionId> = [];
	for (
		let next = fn.instructionNext(site);
		next !== undefined && next !== terminator;
		next = fn.instructionNext(next)
	)
		tail.push(next);
	for (const instruction of tail) editor.moveInstruction(instruction, join);
	editor.replaceValueUses(output, joined);
	editor.setTerminator(join, coreTerminatorInput(fn, terminator));
	editor.moveInstruction(site, fallback);
	editor.replaceInstruction(site, "call", args, {
		attributes: {
			...fn.instructionAttributes(site),
			[CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE]: true,
		},
		sourcePosition: position,
		effectRefinement: fn.instructionEffectRefinement(site),
	});
	const specialized = [...args];
	specialized[0] = editor.appendInstruction(fast, "createFunction", [], {
		attributes: { functionIndex: variant },
		sourcePosition: position,
	}).outputs[0]!;
	specialized[parameter + 2] = editor.appendInstruction(fast, "createUndefined", [], {
		sourcePosition: position,
	}).outputs[0]!;
	const value = editor.appendInstruction(fast, "call", specialized, {
		outputRepresentations: [representation],
		sourcePosition: position,
	}).outputs[0]!;
	editor.setTerminator(fast, { kind: "jump", edge: { block: join, arguments: [value] } });
	editor.setTerminator(fallback, {
		kind: "jump",
		edge: { block: join, arguments: [output] },
	});
	const guard = editor.appendInstruction(block, "guardFunctionIndex", [args[0]!], {
		attributes: { functionIndex: target },
		outputRepresentations: ["boolean"],
		sourcePosition: position,
	}).outputs[0]!;
	editor.replaceTerminator(block, {
		kind: "branch",
		condition: guard,
		consequent: { block: fast, arguments: [] },
		alternate: { block: fallback, arguments: [] },
		sourcePosition: position,
	});
	const handler = fn.kernel.blockHandlerBlock(block);
	if (handler !== undefined) {
		const start = fn.kernel.blockHandlerArgumentStart(block);
		const arguments_ = Array.from(
			{ length: fn.kernel.blockHandlerArgumentCount(block) },
			(_, index) => fn.kernel.handlerArgumentAt(start + index),
		);
		for (const created of [fast, fallback, join])
			editor.setHandler(created, handler, arguments_);
	}
	editor.commit();
}

export function specializeCoreStaticArguments(
	program: CoreProgram,
	analyses: CoreAnalysisManager,
	summaries: CoreProgramSummaries,
	service: CoreTransformCandidateService,
	limits: CoreTransformBudgetLimits,
): ReadonlyArray<CoreFunctionId> {
	const plans = new Map<
		string,
		{
			candidate: CoreTransformCandidate;
			plan: StaticParameterPlan;
			signature: string;
			guarded: boolean;
		}
	>();
	const hints = coreInstanceMethodHints(program);
	let visits = 0;
	for (const caller of program.functionIds()) {
		const fn = program.function(caller);
		let analysis: CoreStaticValueAnalysis | undefined;
		for (const site of summaries.targets.outgoing(caller)) {
			if (++visits > limits.programCompilerWork) break;
			if (
				fn.instructionOpcodeName(site.instruction) !== "call" ||
				fn.instructionAttributes(site.instruction)[
					CORE_GUARDED_INLINE_FALLBACK_ATTRIBUTE
				] === true
			)
				continue;
			const guarded =
				coreCalleeTargetsAreOpen(site.targets) || site.targets.functions.length !== 1;
			const target = !guarded
				? site.targets.functions[0]
				: coreInstanceMethodHint(fn, site.callee, site.receiver, hints);
			if (target === undefined || target === caller) continue;
			const targetFn = program.function(target),
				args = inputs(fn, site.instruction);
			if (
				guarded &&
				(summaries.summary(target)?.readAccessor === undefined ||
					fn.instructionKind(
						fn.blockTerminator(fn.instructionBlock(site.instruction)),
					) === "guard")
			)
				continue;
			for (
				let parameter = 0;
				parameter < targetFn.parameterCount && parameter + 2 < args.length;
				parameter++
			) {
				analysis ??= analyses.get(CORE_STATIC_VALUE_ANALYSIS, {
					scope: "function",
					function: caller,
				});
				const fact = analysis.queryAt(args[parameter + 2]!, site.instruction);
				if (fact.kind !== "known") continue;
				const plan = staticParameterPlan(program, targetFn, parameter, fact, analysis);
				if (plan === undefined || (guarded && plan.kind !== "literal-key")) continue;
				analysis.verify(fact, site.instruction);
				const candidate: CoreTransformCandidate = {
					kind: "static-argument-specialization",
					caller,
					site: site.instruction,
					revision: summaries.version(target),
					priorityClass: 0,
					priorityScore: 0,
					targets: [target],
					generatedCodeCost: plan.cost,
					compilerWorkCost: targetFn.liveStorageCounts().instructions + plan.cost,
					expansive: true,
				};
				if (service.offer(candidate))
					plans.set(`${caller}:${site.instruction}`, {
						candidate,
						plan,
						signature: `${target}:${parameter}:${fact.description}`,
						guarded,
					});
				break;
			}
		}
	}
	const variants = new Map<string, CoreFunctionId>(),
		variantsPerTarget = new Map<CoreFunctionId, number>(),
		changed = new Set<CoreFunctionId>();
	for (
		let candidate = service.next();
		candidate !== undefined;
		candidate = service.next()
	) {
		const entry = plans.get(`${candidate.caller}:${candidate.site}`);
		if (entry === undefined) throw Error("Unexpected static-argument candidate");
		const target = candidate.targets[0]!;
		let variant = variants.get(entry.signature);
		if (variant === undefined && (variantsPerTarget.get(target) ?? 0) >= 4) {
			service.recordDeclined("expansion-limit");
			continue;
		}
		if (entry.plan.kind === "literal-key")
			candidate = {
				...candidate,
				generatedCodeCost:
					(variant === undefined ? entry.plan.cost : 0) + (entry.guarded ? 7 : 2),
				compilerWorkCost:
					(variant === undefined
						? program.function(target).valueCapacity + entry.plan.cost
						: 0) + 12,
			};
		const decline = service.admit(candidate, limits);
		if (decline !== undefined) {
			service.recordDeclined(decline);
			continue;
		}
		if (variant === undefined) {
			variant = cloneWithStaticParameter(program, program.function(target), entry.plan);
			variants.set(entry.signature, variant);
			variantsPerTarget.set(target, (variantsPerTarget.get(target) ?? 0) + 1);
			changed.add(variant);
		}
		if (entry.guarded) {
			guardStaticAccessorCall(
				program,
				candidate.caller,
				candidate.site,
				target,
				variant,
				entry.plan.parameter,
			);
			changed.add(candidate.caller);
			service.recordApplied(candidate);
			continue;
		}
		const fn = program.function(candidate.caller),
			editor = CoreEditor.open(program, candidate.caller),
			block = fn.instructionBlock(candidate.site);
		const args = inputs(fn, candidate.site);
		args[0] = editor.insertInstruction(block, candidate.site, "createFunction", [], {
			attributes: { functionIndex: variant },
		}).outputs[0]!;
		args[entry.plan.parameter + 2] = editor.insertInstruction(
			block,
			candidate.site,
			"createUndefined",
			[],
		).outputs[0]!;
		editor.replaceInstruction(candidate.site, "call", args, {
			attributes: fn.instructionAttributes(candidate.site),
			sourcePosition: fn.instructionSourcePosition(candidate.site),
		});
		editor.commit();
		changed.add(candidate.caller);
		service.recordApplied(candidate);
	}
	return [...changed];
}
