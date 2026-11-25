import {
	COMPILER_VALUE_KIND_NUMBER,
	COMPILER_VALUE_KIND_OBJECT,
	COMPILER_VALUE_KIND_STRING,
	COMPILER_VALUE_KIND_SYMBOL,
	COMPILER_VALUE_KIND_TOP,
	COMPILER_VALUE_KIND_UNDEFINED,
	compilerValueKindMaskIsSubset,
	compilerValueKindMaskIsValid,
} from "../shared/compiler-value-kinds.ts";
import type {
	HostContentValue,
	HostInitialContents,
	HostObjectKind,
} from "../shared/host-result-contracts.ts";
import { COMPILER_UINT32_RANGE, compilerIntegerRange } from "../shared/integer-range.ts";
import { coreBuiltinCallInput } from "./core-builtin-result-projections.ts";
import type { CoreCompilationContext } from "./core-compilation.ts";
import type { CoreNormalResultFacts } from "./core-editor.ts";
import { coreNumericTypedArrayKind } from "./core-heap-brands.ts";
import { coreHostArrayIndex, coreHostPropertyName } from "./core-host-results.ts";
import { coreCanonicalValueRoots } from "./core-ir-control-flow.ts";
import type { CoreControlFlow } from "./core-ir-control-flow.ts";
import type { CoreLoopInductionAnalysis } from "./core-ir-loops.ts";
import { corePrivateHostArrayUses } from "./core-ir-value-kinds.ts";
import { coreInstructionId } from "./core-ir.ts";
import type { CoreFunctionId, CoreInstructionId, CoreValueId } from "./core-ir.ts";
import type { CoreProgramFlowTargetIndex } from "./core-program-flow.ts";
import {
	coreIntrinsicPromiseStaticCall,
	corePromiseContinuation,
	coreSuccessfulAwaitInput,
} from "./core-promise-facts.ts";
import type { CoreRecordValueKind } from "./core-record-value-kinds.ts";
import { coreTerminatorAliasParameter } from "./core-record-value-kinds.ts";
import type { CoreFunctionStore, CoreProgram } from "./core-store.ts";

interface CoreContainerReadFacts extends CoreNormalResultFacts {
	readonly hostObject?: HostObjectKind;
}

const ownKeys: HostInitialContents = {
	kind: "dense-array",
	element: { mask: COMPILER_VALUE_KIND_STRING },
};
const ownValues: HostInitialContents = {
	kind: "dense-array",
	element: { mask: COMPILER_VALUE_KIND_TOP },
};
const ownEntries: HostInitialContents = {
	kind: "dense-array",
	element: {
		mask: COMPILER_VALUE_KIND_OBJECT,
		brand: "Array",
		fields: {
			0: { mask: COMPILER_VALUE_KIND_STRING },
			1: { mask: COMPILER_VALUE_KIND_TOP },
		},
	},
};
const ownSymbols: HostInitialContents = {
	kind: "dense-array",
	element: { mask: COMPILER_VALUE_KIND_SYMBOL },
};
const ownNamesAndSymbols: HostInitialContents = {
	kind: "dense-array",
	element: { mask: COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_SYMBOL },
};

export function coreBuiltinInitialContents(
	fn: CoreFunctionStore,
	instruction: CoreInstructionId,
	mask: (value: CoreValueId) => number | undefined,
): HostInitialContents | undefined {
	if (fn.instructionOpcodeName(instruction) !== "callKnown") return undefined;
	const attributes = fn.instructionAttributes(instruction);
	if (attributes.construct || attributes.argumentMode !== undefined) return undefined;
	switch (attributes.operation) {
		case "Object.keys":
		case "Object.getOwnPropertyNames":
			return ownKeys;
		case "Object.getOwnPropertySymbols":
			return ownSymbols;
		case "Reflect.ownKeys":
			return ownNamesAndSymbols;
		case "Object.values":
			return ownValues;
		case "Object.entries":
			return ownEntries;
		case "String.prototype.split": {
			const separator = coreBuiltinCallInput(fn, instruction, 1);
			if (separator === undefined) return undefined;
			const kind =
				separator.input === undefined
					? COMPILER_VALUE_KIND_UNDEFINED
					: mask(separator.input);
			return kind !== undefined &&
				compilerValueKindMaskIsSubset(
					kind,
					COMPILER_VALUE_KIND_STRING | COMPILER_VALUE_KIND_UNDEFINED,
				)
				? ownKeys
				: undefined;
		}
		default:
			return undefined;
	}
}

export function coreAwaitedHostContents(
	program: CoreProgram,
	fn: CoreFunctionStore,
	projection: CoreInstructionId,
	hostContents: (producer: CoreInstructionId) =>
		| {
				readonly immediate?: HostInitialContents;
				readonly fulfilled?: HostInitialContents;
		  }
		| undefined,
	promiseMembersStable: () => boolean,
	nonCallable: (value: CoreValueId) => boolean,
	identityCallback: (value: CoreValueId) => boolean,
): HostInitialContents | undefined {
	const awaited = coreSuccessfulAwaitInput(fn, projection);
	if (awaited === undefined) return undefined;
	const operand = (id: CoreInstructionId, offset = 0) =>
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(id) + offset);
	const definition = (value: CoreValueId) =>
		fn.kernel.valueDefinitionKind(value) === 1
			? coreInstructionId(fn.kernel.valueDefinitionOwner(value))
			: undefined;
	const consumer = definition(operand(projection));
	if (consumer === undefined) return undefined;
	return adopted(awaited, consumer, undefined, 8);

	function adopted(
		value: CoreValueId,
		consumer: CoreInstructionId,
		methodLoad: CoreInstructionId | undefined,
		budget: number,
	): HostInitialContents | undefined {
		if (budget === 0 || fn.kernel.valueHandlerUseCount(value) !== 0) return undefined;
		for (
			let use = fn.kernel.valueFirstUse(value);
			use >= 0;
			use = fn.kernel.useNext(use)
		) {
			if (fn.kernel.useLive(use) === 0) continue;
			const user = fn.kernel.useInstruction(use);
			if (
				user !== consumer &&
				user !== methodLoad &&
				(fn.instructionKind(user) !== "operation" ||
					fn.instructionOpcodeName(user) !== "rootUse")
			)
				return undefined;
		}
		const producer = definition(value);
		if (producer === undefined) return undefined;
		const opcode = fn.instructionOpcodeName(producer);
		if (opcode === "move" || opcode === "throwIfTdz")
			return adopted(operand(producer), producer, undefined, budget - 1);
		if (opcode !== "call" && opcode !== "callKnown") return undefined;
		const host = hostContents(producer);
		if (host?.fulfilled !== undefined) return host.fulfilled;
		if (!promiseMembersStable()) return undefined;
		if (host?.immediate !== undefined && methodLoad === undefined) return host.immediate;
		const staticCall = coreIntrinsicPromiseStaticCall(fn, producer);
		if (
			staticCall?.operation === "Promise.resolve" &&
			staticCall.firstArgument !== undefined
		)
			return adopted(staticCall.firstArgument, producer, undefined, budget - 1);
		const then = corePromiseContinuation(program, fn, producer);
		if (
			then?.method !== "then" ||
			(then.second !== undefined && !nonCallable(then.second)) ||
			(then.first !== undefined &&
				!nonCallable(then.first) &&
				!identityCallback(then.first))
		)
			return undefined;
		const load = opcode === "call" ? definition(operand(producer)) : undefined;
		if (load !== undefined && fn.valueUseCount(operand(producer)) !== 1) return undefined;
		return adopted(then.receiver, producer, load, budget - 1);
	}
}

export function coreHostRecordFields(
	program: CoreProgram,
	contents: HostInitialContents | undefined,
): CoreRecordValueKind {
	if (contents?.kind !== "record") return undefined;
	return Object.entries(contents.fields).flatMap(([name, field]) => {
		const key = program.stringConstantSlot(name, "first");
		return key === undefined
			? []
			: [
					{
						key,
						mask: field.mask,
						writeMayFail: true as const,
						heapBrand: field.brand,
						integerRange: field.integerRange,
					},
				];
	});
}

export function coreProjectHostContentInputs(
	fn: CoreFunctionStore,
	call: CoreInstructionId,
	contents: HostInitialContents | undefined,
	input: (value: CoreValueId) => CoreNormalResultFacts,
): HostInitialContents | undefined {
	if (
		contents?.kind !== "record" ||
		fn.instructionAttributes(call).argumentMode !== undefined
	)
		return contents;
	let projected: Record<string, HostContentValue> | undefined;
	const start = fn.kernel.instructionOperandStart(call);
	const count = fn.kernel.instructionOperandCount(call);
	for (const [key, field] of Object.entries(contents.fields)) {
		if (field.argument === undefined) continue;
		const position = field.argument + 2;
		const value =
			position >= count
				? { mask: COMPILER_VALUE_KIND_UNDEFINED }
				: input(fn.kernel.operandAt(start + position));
		const mask = field.mask & value.mask;
		if (!compilerValueKindMaskIsValid(mask)) continue;
		const brand =
			mask !== COMPILER_VALUE_KIND_OBJECT
				? undefined
				: value.heapBrand === "Array"
					? "Array"
					: coreNumericTypedArrayKind(value.heapBrand);
		(projected ??= { ...contents.fields })[key] = { ...field, mask, brand };
	}
	return projected === undefined ? contents : { kind: "record", fields: projected };
}

export function coreHostArrayReads(
	program: CoreProgram,
	fn: CoreFunctionStore,
	context: CoreCompilationContext,
	contents: ReadonlyMap<CoreInstructionId, HostInitialContents>,
	control: () => CoreControlFlow,
	induction: () => CoreLoopInductionAnalysis,
	isNumber: (value: CoreValueId) => boolean,
): ReadonlyMap<CoreInstructionId, CoreContainerReadFacts> {
	const seeds = Array.from(contents).flatMap(([allocation, contents]) =>
		contents.kind === "dense-array"
			? [
					{
						allocation,
						root: fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation)),
					},
				]
			: [],
	);
	const results = new Map<CoreInstructionId, CoreContainerReadFacts>();
	if (seeds.length === 0) return results;
	const cfg = control();
	const loops = induction();
	const roots = coreCanonicalValueRoots(fn, cfg);
	const root = (value: CoreValueId) => roots.get(value) ?? value;
	const operand = (instruction: CoreInstructionId, position: number) =>
		fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction) + position);
	const definition = (value: CoreValueId) =>
		fn.kernel.valueDefinitionKind(root(value)) === 1
			? coreInstructionId(fn.kernel.valueDefinitionOwner(root(value)))
			: undefined;
	const literal = (value: CoreValueId) => {
		const producer = definition(value);
		if (producer === undefined) return undefined;
		const opcode = fn.instructionOpcodeName(producer);
		return opcode === "createNumber" || opcode === "createF64"
			? fn.instructionAttributes(producer).value
			: undefined;
	};
	for (const array of corePrivateHostArrayUses(
		program,
		fn,
		cfg,
		context,
		seeds,
		isNumber,
	)) {
		const shape = contents.get(array.allocation);
		if (shape?.kind !== "dense-array") continue;
		const boundLoads = new Set(array.lengthLoads);
		const bounded: Array<CoreValueId> = [];
		const element = elementFacts(shape.element);
		const fixedLength =
			shape.length === undefined
				? undefined
				: compilerIntegerRange(shape.length, shape.length);
		for (const load of array.lengthLoads)
			results.set(load, {
				mask: COMPILER_VALUE_KIND_NUMBER,
				integerRange: fixedLength ?? COMPILER_UINT32_RANGE,
			});
		for (const load of array.elementLoads) {
			const block = fn.instructionBlock(load);
			const position = coreHostArrayIndex(program, fn, load);
			if (
				position !== undefined &&
				shape.length !== undefined &&
				position < shape.length
			) {
				if (element !== undefined) results.set(load, element);
				bounded.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(load)));
				continue;
			}
			if (fn.instructionOpcodeName(load) !== "loadProperty") continue;
			const index = operand(load, 1);
			const range = fixedLength === undefined ? undefined : loops.range(index, block);
			if (
				range !== undefined &&
				range.minimum >= 0 &&
				range.maximum < fixedLength!.minimum
			) {
				if (element !== undefined) results.set(load, element);
				bounded.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(load)));
				continue;
			}
			const counter = loops.induction(index);
			const comparison = counter?.comparison;
			const length = comparison === undefined ? undefined : definition(comparison.bound);
			if (
				counter === undefined ||
				counter.representation !== "f64" ||
				counter.step !== 1 ||
				literal(counter.initial) !== 0 ||
				comparison?.operator !== "<" ||
				length === undefined ||
				!boundLoads.has(length) ||
				root(operand(length, 0)) !== array.root ||
				!counter.loop.blocks.has(block) ||
				counter.loop.preheader === undefined ||
				(cfg.predecessors[counter.loop.header]?.length ?? 0) !== 2 ||
				counter.loop.blocks.has(fn.instructionBlock(array.allocation)) ||
				!cfg.instructionDominatesBlock(
					fn.instructionBlock(array.allocation),
					counter.loop.header,
				) ||
				!cfg.dominatesEdge(counter.loop.header, comparison.body, block)
			)
				continue;
			if (element !== undefined) results.set(load, element);
			bounded.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(load)));
		}
		if (
			shape.element.fields !== undefined &&
			bounded.length === array.elementLoads.length
		)
			privateElementFieldReads(bounded, shape.element.fields, 3);
	}
	return results;

	function privateElementFieldReads(
		values: ReadonlyArray<CoreValueId>,
		fields: Readonly<Record<string, HostContentValue>>,
		depth: number,
	): void {
		let remaining = 128;
		const pending = [...values];
		const seen = new Set<CoreValueId>();
		const reads = new Map<CoreInstructionId, HostContentValue>();
		while (pending.length !== 0) {
			const value = pending.pop()!;
			if (seen.has(value)) continue;
			seen.add(value);
			if (fn.kernel.valueHandlerUseCount(value) !== 0) return;
			for (
				let use = fn.kernel.valueFirstUse(value);
				use >= 0;
				use = fn.kernel.useNext(use)
			) {
				if (fn.kernel.useLive(use) === 0) continue;
				if (--remaining < 0) return;
				const user = fn.kernel.useInstruction(use);
				const position = fn.kernel.useOperand(use);
				if (fn.instructionKind(user) !== "operation") {
					const alias = coreTerminatorAliasParameter(fn, user, position);
					if (alias === undefined || alias === null || root(alias) !== root(value))
						return;
					pending.push(alias);
					continue;
				}
				const opcode = fn.instructionOpcodeName(user);
				if (opcode === "rootUse" || opcode === "typeofCompare" || opcode === "isEmpty")
					continue;
				if (position !== 0) return;
				if (
					opcode === "move" ||
					opcode === "throwIfTdz" ||
					opcode === "requireCoercible"
				) {
					if (fn.kernel.instructionResultCount(user) !== 0)
						pending.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(user)));
					continue;
				}
				if (opcode !== "loadPropertyStatic" && opcode !== "loadProperty") return;
				const key =
					coreHostPropertyName(program, fn, user) ??
					coreHostArrayIndex(program, fn, user)?.toString();
				if (key === undefined || !Object.hasOwn(fields, key)) return;
				reads.set(user, fields[key]!);
			}
		}
		const nested = new Map<
			Readonly<Record<string, HostContentValue>>,
			Array<CoreValueId>
		>();
		for (const [user, field] of reads) {
			const facts = elementFacts(field);
			if (facts !== undefined) results.set(user, facts);
			if (depth === 0 || field.fields === undefined) continue;
			const values = nested.get(field.fields) ?? [];
			values.push(fn.kernel.resultAt(fn.kernel.instructionResultStart(user)));
			nested.set(field.fields, values);
		}
		for (const [fields, values] of nested)
			privateElementFieldReads(values, fields, depth - 1);
	}
}

type HostArrayContents = Extract<HostInitialContents, { kind: "dense-array" }>;

function sameHostArrayContents(
	left: HostArrayContents,
	right: HostArrayContents,
): boolean {
	return (
		left.length === right.length &&
		left.element.mask === right.element.mask &&
		left.element.brand === right.element.brand &&
		left.element.hostObject === right.element.hostObject &&
		left.element.fields === right.element.fields &&
		left.element.integerRange === right.element.integerRange
	);
}

function coreReturnedHostArrayContents(
	program: CoreProgram,
	fn: CoreFunctionStore,
	context: CoreCompilationContext,
	contents: ReadonlyMap<CoreInstructionId, HostInitialContents>,
	control: () => CoreControlFlow,
): HostArrayContents | undefined {
	if (fn.isAsync || fn.isGenerator) return undefined;
	const seeds = Array.from(contents).flatMap(([allocation, shape]) =>
		shape.kind === "dense-array"
			? [
					{
						allocation,
						root: fn.kernel.resultAt(fn.kernel.instructionResultStart(allocation)),
					},
				]
			: [],
	);
	if (seeds.length === 0) return undefined;
	const cfg = control();
	const privateReturns = new Map(
		corePrivateHostArrayUses(program, fn, cfg, context, seeds, () => false, true)
			.filter((array) => array.elementLoads.length === 0)
			.map((array) => [array.root, array.allocation]),
	);
	if (privateReturns.size === 0) return undefined;
	const roots = coreCanonicalValueRoots(fn, cfg);
	let returned: HostArrayContents | undefined;
	for (const block of cfg.reachable) {
		const instruction = fn.blockTerminator(block);
		if (fn.instructionKind(instruction) !== "return") continue;
		const value = fn.kernel.operandAt(fn.kernel.instructionOperandStart(instruction));
		const source = privateReturns.get(roots.get(value) ?? value);
		const shape = source === undefined ? undefined : contents.get(source);
		if (
			shape?.kind !== "dense-array" ||
			(returned !== undefined && !sameHostArrayContents(returned, shape))
		)
			return undefined;
		returned = shape;
	}
	return returned;
}

export function propagateCoreHostArrayReturns(
	program: CoreProgram,
	targets: CoreProgramFlowTargetIndex,
	context: CoreCompilationContext,
	contents: Map<CoreFunctionId, Map<CoreInstructionId, HostInitialContents>>,
	control: (functionId: CoreFunctionId) => CoreControlFlow,
): void {
	const returned = new Map<CoreFunctionId, HostArrayContents>();
	let pending: ReadonlySet<CoreFunctionId> = new Set(contents.keys());
	let remaining = 256;
	for (let depth = 0; depth < 8 && pending.size > 0 && remaining > 0; depth++) {
		const callers = new Set<CoreFunctionId>();
		for (const id of pending) {
			if (returned.has(id) || targets.graph.exactCallers(id).length === 0) continue;
			if (--remaining < 0) break;
			const shape = coreReturnedHostArrayContents(
				program,
				program.function(id),
				context,
				contents.get(id)!,
				() => control(id),
			);
			if (shape === undefined) continue;
			returned.set(id, shape);
			for (const caller of targets.graph.exactCallers(id)) callers.add(caller);
		}
		const next = new Set<CoreFunctionId>();
		for (const caller of callers) {
			const fn = program.function(caller);
			let row = contents.get(caller);
			for (const site of targets.outgoing(caller)) {
				if (
					site.targets.opaque ||
					site.targets.anyScript ||
					row?.has(site.instruction) ||
					fn.kernel.instructionResultCount(site.instruction) !== 1 ||
					fn.registry.byId(fn.instructionOpcode(site.instruction)).callTransfer
						?.result !== "call-completion"
				)
					continue;
				const shape = returned.get(site.targets.functions[0]!);
				if (
					shape === undefined ||
					!site.targets.functions.every((target) => {
						const alternative = returned.get(target);
						return alternative !== undefined && sameHostArrayContents(shape, alternative);
					})
				)
					continue;
				if (row === undefined)
					contents.set(caller, (row = new Map<CoreInstructionId, HostInitialContents>()));
				row.set(site.instruction, shape);
				next.add(caller);
			}
		}
		pending = next;
	}
}

function elementFacts(element: HostContentValue): CoreContainerReadFacts | undefined {
	if (!compilerValueKindMaskIsValid(element.mask)) return undefined;
	return {
		mask: element.mask,
		heapBrand: element.mask === COMPILER_VALUE_KIND_OBJECT ? element.brand : undefined,
		hostObject:
			element.mask === COMPILER_VALUE_KIND_OBJECT ? element.hostObject : undefined,
		integerRange: element.integerRange,
	};
}
