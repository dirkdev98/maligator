import { builtinWorldAssumptions } from "../shared/builtin-assumptions.ts";
import type { KnownArgumentMode } from "../shared/known-operations.ts";
import { knownOperationCall, knownOperationIndex } from "../shared/known-operations.ts";
import { getPrimordialCatalog } from "../shared/primordial-catalog-data.ts";
import {
	provePrimordialAccess,
	primordialConstantDescription,
} from "../shared/primordial-catalog.ts";
import type { PrimordialKey } from "../shared/primordial-catalog.ts";
import type { StaticDescriptionId } from "../shared/static-values.ts";
import { CoreEditor } from "./core-editor.ts";
import type { CoreAttributeValue, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import { coreInstructionId } from "./core-ir.ts";
import { CORE_O2_PASS_BUDGETS } from "./core-optimization-families.ts";
import type { CoreFunctionPass } from "./core-pass.ts";
import {
	coreStaticMemberOperation,
	coreStaticConstantOperation,
} from "./core-static-value-selection.ts";
import type { CoreStaticMemberOperation } from "./core-static-value-selection.ts";
import { CORE_STATIC_VALUE_ANALYSIS } from "./core-static-values.ts";
import type { CoreStaticValueAnalysis } from "./core-static-values.ts";
import type { CoreFunctionStore } from "./core-store.ts";
import type { CoreProgram } from "./core-store.ts";

type Argument = CoreValueId | CoreStaticMemberOperation;
const undefinedArgument: CoreStaticMemberOperation = {
	opcode: "createUndefined",
	inputs: [],
};

interface InvocationTarget {
	readonly operation: string;
	readonly receiver?: Argument;
	readonly leading: ReadonlyArray<Argument>;
}

function invocationTarget(
	analysis: CoreStaticValueAnalysis,
	fn: CoreFunctionStore,
	value: CoreValueId,
	depth = 0,
): InvocationTarget | undefined {
	if (depth > 8) return undefined;
	const fact = analysis.query(value);
	if (
		fact.kind === "known" &&
		fact.canonical !== undefined &&
		knownOperationIndex(fact.canonical) !== undefined
	)
		return { operation: fact.canonical, leading: [] };
	if (fn.kernel.valueDefinitionKind(value) !== 1) return undefined;
	const definition = coreInstructionId(fn.kernel.valueDefinitionOwner(value));
	const opcode = fn.instructionOpcodeName(definition),
		args = inputs(fn, definition);
	if (opcode === "move") return invocationTarget(analysis, fn, args[0]!, depth + 1);
	let binding: ReadonlyArray<CoreValueId>;
	if (
		opcode === "callKnown" &&
		fn.instructionAttributes(definition).operation === "Function.prototype.bind" &&
		fn.instructionAttributes(definition).argumentMode === undefined
	)
		binding = args;
	else if (opcode === "call") {
		const callee = analysis.query(args[0]!);
		if (callee.kind !== "known" || callee.canonical !== "Function.prototype.bind")
			return undefined;
		binding = args.slice(1);
	} else return undefined;
	const target = invocationTarget(analysis, fn, binding[0]!, depth + 1);
	return target === undefined
		? undefined
		: {
				operation: target.operation,
				receiver: target.receiver ?? binding[1] ?? undefinedArgument,
				leading: [...target.leading, ...binding.slice(2)],
			};
}

function argumentList(
	program: CoreProgram,
	analysis: CoreStaticValueAnalysis,
	value: CoreValueId | undefined,
	consumer: CoreInstructionId,
	nullable: boolean,
): ReadonlyArray<Argument> | undefined {
	if (value === undefined) return nullable ? [] : undefined;
	const fact = analysis.queryAt(value, consumer);
	if (fact.kind !== "known") return undefined;
	if (nullable && (fact.brand === "undefined" || fact.brand === "null")) return [];
	const description = program.staticDescriptions.description(fact.description);
	if (
		description.kind !== "array" ||
		description.length === null ||
		description.length > 64 ||
		description.ownKeysComplete === false
	)
		return undefined;
	const arguments_: Array<Argument> = [];
	for (let index = 0; index < description.length; index++) {
		const property = description.properties.find(
			(property) => property.key === String(index),
		);
		if (property === undefined) {
			if (analysis.inherited(fact, String(index))?.kind !== "absent") return undefined;
			arguments_.push(undefinedArgument);
		} else {
			if (property.descriptor.kind !== "data") return undefined;
			const operation = coreStaticMemberOperation(
				program,
				property.descriptor.value,
				fact.operands,
			);
			if (operation === undefined) return undefined;
			arguments_.push(operation);
		}
	}
	analysis.verify(fact, consumer);
	return arguments_;
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

function propertyKey(
	analysis: CoreStaticValueAnalysis,
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	args: ReadonlyArray<CoreValueId>,
): PrimordialKey | undefined {
	if (fn.instructionOpcodeName(instruction).endsWith("Static"))
		return analysis.string(fn.instructionAttributes(instruction).stringIndex as number);
	const constant = analysis.constant(args[1]!);
	if (constant !== undefined)
		return constant.kind === "undefined" ? "undefined" : String(constant.value);
	const key = analysis.query(args[1]!);
	return key.kind === "known" && key.brand === "symbol" && key.canonical !== undefined
		? { symbol: key.canonical }
		: undefined;
}

export const resolveKnownOperations: CoreFunctionPass = {
	name: "resolve-known-operations",
	stage: "memory",
	requiredFunctionOpcodesAny: [
		"call",
		"construct",
		"callSpread",
		"callSpreadIterable",
		"constructSpread",
		"loadProperty",
		"loadPropertyStatic",
		"loadGlobalProperty",
		"storeProperty",
		"storePropertyStatic",
	],
	admission: {
		predicate: "exact primordial operation in a locked single realm",
		hasOpportunity({ compilationContext }) {
			return (
				compilationContext.facts.world.primordialPolicy === "locked" &&
				!compilationContext.facts.world.realms
			);
		},
	},
	requiredAnalyses: [CORE_STATIC_VALUE_ANALYSIS],
	wakesOn: ["body", "memoryEffects", "facts"],
	changes: { cfg: false, calls: true, facts: true, representations: false },
	budget: CORE_O2_PASS_BUDGETS["provenance-escape-scalar-replacement"],
	run(context) {
		const { program, item, compilationContext } = context;
		if (
			compilationContext.facts.world.primordialPolicy !== "locked" ||
			compilationContext.facts.world.realms
		)
			return undefined;
		const fn = program.function(item.function),
			analysis = context.analysis(CORE_STATIC_VALUE_ANALYSIS);
		const plans: Array<{
			instruction: CoreInstructionId;
			opcode: "loadPrimordial" | "callKnown";
			args: ReadonlyArray<Argument>;
			attributes: Record<string, CoreAttributeValue>;
			store?: boolean;
		}> = [];
		const constants: Array<{
			instruction: CoreInstructionId;
			description: StaticDescriptionId;
		}> = [];
		const call = (
			instruction: CoreInstructionId,
			operation: string,
			args: ReadonlyArray<Argument>,
			construct = false,
			store = false,
			argumentMode?: KnownArgumentMode,
		) => {
			if (knownOperationIndex(operation) === undefined) return;
			plans.push({
				instruction,
				opcode: "callKnown",
				args,
				store,
				attributes: {
					operation,
					...(construct ? { construct: true } : {}),
					...(argumentMode === undefined ? {} : { argumentMode }),
					knownBuiltinCall: knownOperationCall(
						operation,
						fn.id,
					) as unknown as CoreAttributeValue,
					worldAssumptions: {
						...builtinWorldAssumptions(operation, "exact-builtin-proof", true),
					},
				},
			});
		};
		for (const instruction of fn.instructionIds()) {
			if (plans.length + constants.length * 2 + 2 > context.remainingEdits) break;
			if (fn.instructionKind(instruction) !== "operation") continue;
			const opcode = fn.instructionOpcodeName(instruction),
				args = inputs(fn, instruction);
			if (
				opcode === "call" ||
				opcode === "construct" ||
				opcode === "callSpread" ||
				opcode === "callSpreadIterable" ||
				opcode === "constructSpread"
			) {
				let target = invocationTarget(analysis, fn, args[0]!);
				if (target === undefined) continue;
				let construct = opcode === "construct" || opcode === "constructSpread";
				let receiver: Argument = args[construct ? 0 : 1]!;
				let arguments_: ReadonlyArray<Argument> = args.slice(construct ? 1 : 2);
				let argumentMode: KnownArgumentMode | undefined =
					opcode === "callSpreadIterable"
						? "iterable"
						: opcode.endsWith("Spread")
							? "array"
							: undefined;
				if (opcode === "call" && target.operation === "Function.prototype.call") {
					const invoked = invocationTarget(analysis, fn, args[1]!);
					if (invoked !== undefined) {
						target = invoked;
						receiver = args[2] ?? undefinedArgument;
						arguments_ = args.slice(3);
					}
				} else if (
					opcode === "call" &&
					["Function.prototype.apply", "Reflect.apply", "Reflect.construct"].includes(
						target.operation,
					)
				) {
					const reflect = target.operation.startsWith("Reflect.");
					const isConstruct = target.operation === "Reflect.construct";
					const value = args[reflect ? 2 : 1];
					const invoked =
						value === undefined ? undefined : invocationTarget(analysis, fn, value);
					const list = argumentList(
						program,
						analysis,
						args[isConstruct ? 3 : reflect ? 4 : 3],
						instruction,
						!reflect,
					);
					if (invoked !== undefined) {
						target = invoked;
						construct = isConstruct;
						receiver = isConstruct
							? (args[4] ?? value!)
							: (args[reflect ? 3 : 2] ?? undefinedArgument);
						arguments_ = list ?? [
							args[isConstruct ? 3 : reflect ? 4 : 3] ?? undefinedArgument,
						];
						if (list === undefined)
							argumentMode = reflect ? "array-like" : "nullable-array-like";
						if (construct && invoked.receiver !== undefined && receiver === value)
							receiver = primordialArgument(invoked.operation);
					}
				}
				if (target.receiver !== undefined) {
					if (!construct) receiver = target.receiver;
					else if (receiver === args[0]) receiver = primordialArgument(target.operation);
				}
				call(
					instruction,
					target.operation,
					[receiver, ...target.leading, ...arguments_],
					construct,
					false,
					argumentMode,
				);
				continue;
			}
			if (opcode === "loadGlobalProperty") {
				const fact = analysis.query(
					fn.kernel.resultAt(fn.kernel.instructionResultStart(instruction)),
				);
				if (fact.kind === "known" && fact.canonical !== undefined) {
					const operation = primordialArgument(fact.canonical);
					plans.push({
						instruction,
						opcode: "loadPrimordial",
						args: [],
						attributes: { ...operation.attributes },
					});
				}
				continue;
			}
			const store = opcode === "storeProperty" || opcode === "storePropertyStatic";
			if (!store && opcode !== "loadProperty" && opcode !== "loadPropertyStatic")
				continue;
			const key = propertyKey(analysis, fn, instruction, args);
			if (key === undefined) continue;
			const base = analysis.queryAt(args[0]!, instruction);
			if (base.kind !== "known") continue;
			const proof =
				base.canonical === undefined || base.brand === "symbol"
					? analysis.inherited(base, key)
					: provePrimordialAccess(
							compilationContext.facts.world,
							{ kind: "intrinsic", id: base.canonical, realm: "current" },
							key,
						);
			const resolution = proof?.resolution;
			if (resolution === undefined) continue;
			analysis.verify(base, instruction);
			if (store) {
				if (resolution.setter !== undefined)
					call(
						instruction,
						resolution.setter[0],
						[args[0]!, args[args.length - 1]!],
						false,
						true,
					);
			} else if (resolution.getter !== undefined) {
				call(instruction, resolution.getter[0], [args[0]!]);
			} else if (resolution.value !== undefined && (resolution.value[2] & 9) !== 0) {
				const nodeIndex =
					typeof resolution.descriptor[2] === "number" ? resolution.descriptor[2] : -1;
				if (getPrimordialCatalog().nodes[nodeIndex] !== resolution.value)
					throw new Error("Invalid primordial reference");
				plans.push({
					instruction,
					opcode: "loadPrimordial",
					args: [],
					attributes: {
						nodeIndex,
						worldAssumptions: {
							...builtinWorldAssumptions(
								resolution.value[0],
								"exact-builtin-proof",
								true,
							),
						},
					},
				});
			} else {
				const description = primordialConstantDescription(resolution.descriptor[2]);
				if (description !== undefined)
					constants.push({
						instruction,
						description: program.staticDescriptions.intern(description),
					});
			}
		}
		if (plans.length === 0 && constants.length === 0) return undefined;
		const editor = CoreEditor.open(program, fn.id);
		for (const plan of constants) {
			const constant = coreStaticConstantOperation(program, plan.description, editor);
			if (constant !== undefined)
				editor.replaceInstruction(plan.instruction, constant.opcode, constant.inputs, {
					attributes: constant.attributes,
				});
		}
		for (const plan of plans) {
			const options = {
				attributes: plan.attributes,
				sourcePosition: fn.instructionSourcePosition(plan.instruction),
			};
			const args = plan.args.map((argument) =>
				typeof argument === "number"
					? argument
					: editor.insertInstruction(
							fn.instructionBlock(plan.instruction),
							plan.instruction,
							argument.opcode,
							argument.inputs,
							{ attributes: argument.attributes },
						).outputs[0]!,
			);
			if (plan.store) {
				editor.insertInstruction(
					fn.instructionBlock(plan.instruction),
					plan.instruction,
					plan.opcode,
					args,
					options,
				);
				editor.removeInstruction(plan.instruction);
			} else editor.replaceInstruction(plan.instruction, plan.opcode, args, options);
		}
		return editor.commit();
	},
};

function primordialArgument(operation: string): CoreStaticMemberOperation {
	const nodeIndex = getPrimordialCatalog().nodes.findIndex(
		(node) => node[0] === operation,
	);
	return {
		opcode: "loadPrimordial",
		inputs: [],
		attributes: {
			nodeIndex,
			worldAssumptions: {
				...builtinWorldAssumptions(operation, "exact-builtin-proof", true),
			},
		},
	};
}
