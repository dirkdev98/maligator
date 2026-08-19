import type { CompilerSiteFacts } from "./compiler-facts.ts";
import type {
	CompilerImmediateValue,
	CompilerInstruction,
} from "./compiler-instruction.ts";
import { buildCoreControlFlow, coreTerminatorEdges } from "./core-ir-control-flow.ts";
import { coreOpcodeRegistry } from "./core-ir-opcodes.ts";
import type { CoreAllocatedRegion } from "./core-ir-regions.ts";
import { verifyCoreFunction } from "./core-ir-verifier.ts";
import type {
	CoreBlockId,
	CoreEdge,
	CoreFunction,
	CoreImmediate,
	CoreInstructionId,
	CoreProgram,
	CoreRegion,
	CoreRepresentation,
	CoreValueId,
} from "./core-ir.ts";

export interface CoreTargetProgram {
	readonly core: CoreProgram;
	readonly functions: Array<CoreTargetFunction>;
	readonly gcRootRegisters: ReadonlyArray<ReadonlyArray<number> | undefined>;
}

export interface CoreTargetFunction {
	readonly sourcePath: string;
	readonly functionIndex: number;
	readonly nameStringIndex: number;
	readonly blocks: Array<{ readonly instructions: Array<CompilerInstruction> }>;
	readonly regions?: ReadonlyArray<CoreAllocatedRegion>;
	readonly isGenerator: boolean;
	readonly isAsync: boolean;
	readonly parameterCount: number;
	readonly mappedArgumentSlots: Array<number>;
	readonly mappedArguments: boolean;
	readonly length: number;
	readonly registerCount: number;
	/** Physical register classes selected from canonical Core value representations. */
	readonly registerRepresentations: ReadonlyArray<"boxed" | "number" | "boolean">;
	readonly capturedCount: number;
	readonly strict: boolean;
	readonly isClassConstructor: boolean;
	readonly isDerivedConstructor: boolean;
	readonly hasPrototype: boolean;
}

function parallelMoves(
	assignments: ReadonlyArray<{ readonly destination: number; readonly source: number }>,
	nextRegister: { value: number },
	registerRepresentations: Map<number, CoreRepresentation>,
): Array<CompilerInstruction> {
	const pending = assignments
		.filter(({ destination, source }) => destination !== source)
		.map((assignment) => ({ ...assignment }));
	const result: Array<CompilerInstruction> = [];
	while (pending.length > 0) {
		const ready = pending.findIndex(
			({ destination }) => !pending.some(({ source }) => source === destination),
		);
		if (ready >= 0) {
			const [assignment] = pending.splice(ready, 1);
			result.push({
				type: "move",
				registers: [assignment!.destination, assignment!.source],
			});
			continue;
		}
		const saved = pending[0]!.destination;
		const temporary = nextRegister.value++;
		const representation = registerRepresentations.get(saved);
		if (representation === undefined) {
			throw new Error(`Parallel move has no Core representation for r${saved}`);
		}
		registerRepresentations.set(temporary, representation);
		result.push({ type: "move", registers: [temporary, saved] });
		for (const assignment of pending) {
			if (assignment.source === saved) assignment.source = temporary;
		}
	}
	return result;
}

function rebuildInstruction(
	core: CoreFunction,
	instruction: CoreFunction["blocks"][number]["instructions"][number],
	registerForValue: (value: CoreValueId) => number,
): CompilerInstruction {
	const registers = [...instruction.outputs, ...instruction.inputs].map(registerForValue);
	const immediateValues: Array<CompilerImmediateValue | undefined> = [];
	if (instruction.opcode === "call" || instruction.opcode === "construct") {
		for (const [index, input] of instruction.inputs.entries()) {
			const value = coreImmediateValue(core, input);
			if (value === undefined) continue;
			const position = instruction.outputs.length + index;
			registers[position] = -1;
			immediateValues[position] = value;
		}
	}
	return {
		type: instruction.opcode,
		...instruction.attributes,
		...(immediateValues.length === 0 ? {} : { immediateValues }),
		...(["asyncStart", "generatorStart", "initGlobalVars"].includes(instruction.opcode)
			? {}
			: { registers }),
	} as CompilerInstruction;
}

function coreImmediateValue(
	core: CoreFunction,
	value: CoreValueId,
): CompilerImmediateValue | undefined {
	const definition = core.values.find(({ id }) => id === value)?.definition;
	if (definition?.kind !== "instruction") return undefined;
	const instruction = core.blocks
		.flatMap(({ instructions }) => instructions)
		.find(({ id }) => id === definition.instruction);
	if (instruction === undefined || definition.index !== 0) return undefined;
	switch (instruction.opcode) {
		case "createUndefined":
			return { kind: "undefined" };
		case "createNull":
			return { kind: "null" };
		case "createBoolean":
			return typeof instruction.attributes.value === "boolean"
				? { kind: "boolean", value: instruction.attributes.value }
				: undefined;
		case "createNumber":
		case "createF64": {
			const number = instruction.attributes.value;
			return typeof number === "number" &&
				Number.isInteger(number) &&
				!Object.is(number, -0) &&
				number >= -0x0800_0000 &&
				number <= 0x07ff_ffff
				? { kind: "number", value: number }
				: undefined;
		}
		case "createString": {
			const index = instruction.attributes.stringIndex;
			return typeof index === "number" && index <= 0x0fff_ffff
				? { kind: "string", index }
				: undefined;
		}
		default:
			return undefined;
	}
}

function sourcePositionMarker(position: number | undefined): Array<CompilerInstruction> {
	return position === undefined ? [] : [{ type: "sourcePos", pos: position }];
}

function lowerCoreImmediate(
	value: CoreImmediate,
	destination: number,
): CompilerInstruction {
	switch (value.kind) {
		case "undefined":
			return { type: "createUndefined", registers: [destination] };
		case "null":
			return { type: "createNull", registers: [destination] };
		case "boolean":
			return {
				type: "createBoolean",
				registers: [destination],
				value: value.value,
			};
		case "number":
			return {
				type: "createNumber",
				registers: [destination],
				value: value.value,
			};
		case "string":
			return {
				type: "createString",
				registers: [destination],
				stringIndex: value.index,
			};
	}
}

function lowerCoreRegionData(
	value: unknown,
	instructions: ReadonlyMap<CoreInstructionId, CompilerInstruction>,
	blocks: ReadonlyMap<CoreBlockId, number>,
	values: ReadonlyMap<CoreValueId, number>,
): unknown {
	if (value === undefined || value === null || typeof value !== "object") return value;
	if (Array.isArray(value)) {
		return value.map((entry) => lowerCoreRegionData(entry, instructions, blocks, values));
	}
	const object = value as Readonly<Record<string, unknown>>;
	if (Object.keys(object).length === 1 && typeof object.$coreInstruction === "number") {
		const instruction = instructions.get(object.$coreInstruction as CoreInstructionId);
		if (instruction === undefined) {
			throw new Error(
				`Core region lowering lost instruction @${object.$coreInstruction}`,
			);
		}
		return instruction;
	}
	if (Object.keys(object).length === 1 && typeof object.$coreBlock === "number") {
		const block = blocks.get(object.$coreBlock as CoreBlockId);
		if (block === undefined) {
			throw new Error(`Core region lowering lost block b${object.$coreBlock}`);
		}
		return block;
	}
	if (Object.keys(object).length === 1 && typeof object.$coreValue === "number") {
		const register = values.get(object.$coreValue as CoreValueId);
		if (register === undefined) {
			throw new Error(`Core region lowering lost value %${object.$coreValue}`);
		}
		return register;
	}
	const result: Record<string, unknown> = {};
	for (const [key, entry] of Object.entries(object)) {
		result[key] = lowerCoreRegionData(entry, instructions, blocks, values);
	}
	return result;
}

function lowerCoreRegions(
	regions: ReadonlyArray<CoreRegion>,
	instructions: ReadonlyMap<CoreInstructionId, CompilerInstruction>,
	omittedBlocks: ReadonlySet<CoreBlockId>,
	blocks: ReadonlyMap<CoreBlockId, number>,
	values: ReadonlyMap<CoreValueId, number>,
): ReadonlyArray<CoreAllocatedRegion> | undefined {
	if (regions.length === 0) return undefined;
	const requireInstruction = (id: CoreInstructionId): CompilerInstruction => {
		const instruction = instructions.get(id);
		if (instruction === undefined) {
			throw new Error(`Core region lowering lost instruction @${id}`);
		}
		return instruction;
	};
	const requireBlock = (id: CoreBlockId): number => {
		const block = blocks.get(id);
		if (block === undefined) throw new Error(`Core region lowering lost block b${id}`);
		return block;
	};
	return regions.map((region) => ({
		...(lowerCoreRegionData(region.data, instructions, blocks, values) as object),
		kind: region.kind,
		anchors: region.anchors.map(requireInstruction),
		claimedInstructions: region.claimedInstructions.map(requireInstruction),
		controlFlow: {
			ordinaryBlocks: region.ordinaryBlocks
				.filter((block) => !omittedBlocks.has(block))
				.map(requireBlock),
			exceptionalBlocks: region.exceptionalBlocks
				.filter((block) => !omittedBlocks.has(block))
				.map(requireBlock),
		},
	})) as unknown as ReadonlyArray<CoreAllocatedRegion>;
}

export function coreRegisterClasses(
	core: CoreFunction,
	reuseRegisters = true,
): {
	readonly roots: ReadonlyMap<CoreValueId, CoreValueId>;
	readonly registers: Map<CoreValueId, number>;
	readonly gcRootRegisters: ReadonlyArray<number>;
	readonly registerRepresentations: Map<number, CoreRepresentation>;
} {
	const representations = new Map(
		core.values.map(({ id, representation }) => [id, representation]),
	);
	const uses = core.blocks.map(() => new Set<CoreValueId>());
	const definitions = core.blocks.map(() => new Set<CoreValueId>());
	const successors = core.blocks.map(() => new Set<CoreBlockId>());
	const handlerParameters = (
		block: CoreFunction["blocks"][number],
	): ReadonlyArray<CoreValueId> => {
		if (block.handler === undefined) return [];
		const target = core.blocks[block.handler.block];
		if (target === undefined || target.parameters[0]?.role !== "exception") {
			throw new Error(`Core handler b${block.handler.block} has no exception parameter`);
		}
		const parameters = target.parameters.slice(1).map(({ value }) => value);
		if (parameters.length !== block.handler.arguments.length) {
			throw new Error(
				`Core handler b${block.handler.block} expects ${parameters.length} explicit arguments, received ${block.handler.arguments.length}`,
			);
		}
		return parameters;
	};
	const terminatorValues = (
		block: CoreFunction["blocks"][number],
	): Array<CoreValueId> => {
		const edgeArguments = coreTerminatorEdges(block.terminator).flatMap(
			(edge) => edge.arguments,
		);
		switch (block.terminator.kind) {
			case "branch":
			case "guard":
				return [block.terminator.condition, ...edgeArguments];
			case "switch":
				return [block.terminator.discriminant, ...edgeArguments];
			case "return":
			case "throw":
				return [block.terminator.value];
			case "jump":
				return edgeArguments;
			case "unreachable":
				return [];
		}
	};
	for (const block of core.blocks) {
		const blockUses = uses[block.id]!;
		const blockDefinitions = definitions[block.id]!;
		for (const { value } of block.parameters) blockDefinitions.add(value);
		const addUse = (value: CoreValueId): void => {
			if (!blockDefinitions.has(value)) blockUses.add(value);
		};
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) addUse(input);
			for (const output of instruction.outputs) blockDefinitions.add(output);
		}
		for (const value of terminatorValues(block)) addUse(value);
		for (const argument of block.handler?.arguments ?? []) addUse(argument);
		for (const edge of coreTerminatorEdges(block.terminator)) {
			successors[block.id]!.add(edge.block);
		}
		if (block.handler !== undefined) successors[block.id]!.add(block.handler.block);
	}
	const liveIn = core.blocks.map((_, index) => new Set(uses[index]));
	const liveOut = core.blocks.map(() => new Set<CoreValueId>());
	let changed = true;
	while (changed) {
		changed = false;
		for (let index = core.blocks.length - 1; index >= 0; index--) {
			const nextOut = new Set<CoreValueId>();
			for (const successor of successors[index]!) {
				for (const value of liveIn[successor]!) nextOut.add(value);
			}
			const nextIn = new Set(uses[index]);
			for (const value of nextOut) {
				if (!definitions[index]!.has(value)) nextIn.add(value);
			}
			if (
				nextOut.size !== liveOut[index]!.size ||
				[...nextOut].some((value) => !liveOut[index]!.has(value)) ||
				nextIn.size !== liveIn[index]!.size ||
				[...nextIn].some((value) => !liveIn[index]!.has(value))
			) {
				liveOut[index] = nextOut;
				liveIn[index] = nextIn;
				changed = true;
			}
		}
	}
	const interference = new Map<CoreValueId, Set<CoreValueId>>(
		core.values.map(({ id }) => [id, new Set()]),
	);
	const interfere = (left: CoreValueId, right: CoreValueId): void => {
		if (left === right) return;
		interference.get(left)!.add(right);
		interference.get(right)!.add(left);
	};
	for (const block of core.blocks) {
		const live = new Set(liveOut[block.id]);
		for (const value of terminatorValues(block)) live.add(value);
		// Register lowering materializes the exceptional edge before entering the
		// protected block: handler arguments are copied into the handler's explicit
		// parameter registers immediately after tryBegin. Those destination values
		// must then survive every instruction that may transfer to the handler.
		for (const parameter of handlerParameters(block)) live.add(parameter);
		for (let index = block.instructions.length - 1; index >= 0; index--) {
			const instruction = block.instructions[index]!;
			for (const output of instruction.outputs) {
				for (const value of live) interfere(output, value);
			}
			for (const left of instruction.outputs) {
				for (const right of instruction.outputs) interfere(left, right);
				live.delete(left);
			}
			for (const input of instruction.inputs) live.add(input);
		}
		for (const { value } of block.parameters) {
			for (const liveValue of live) interfere(value, liveValue);
			for (const { value: other } of block.parameters) interfere(value, other);
		}
	}
	const parent = new Map<CoreValueId, CoreValueId>(core.values.map(({ id }) => [id, id]));
	const members = new Map<CoreValueId, Set<CoreValueId>>(
		core.values.map(({ id }) => [id, new Set([id])]),
	);
	const abi = new Map<CoreValueId, number>(
		core.parameters.map((value, index) => [value, index]),
	);
	let snapshotIndex = 0;
	for (const instruction of core.blocks[core.entry]!.instructions) {
		if (
			instruction.opcode !== "loadArgumentCount" &&
			instruction.opcode !== "loadArgument"
		) {
			break;
		}
		const output = instruction.outputs[0];
		if (output !== undefined) {
			abi.set(output, core.parameters.length + snapshotIndex++);
		}
	}
	const find = (value: CoreValueId): CoreValueId => {
		const direct = parent.get(value)!;
		if (direct === value) return value;
		const root = find(direct);
		parent.set(value, root);
		return root;
	};
	const union = (left: CoreValueId, right: CoreValueId): boolean => {
		const leftRoot = find(left);
		const rightRoot = find(right);
		if (leftRoot === rightRoot) return true;
		if (representations.get(leftRoot) !== representations.get(rightRoot)) return false;
		const leftAbi = [...members.get(leftRoot)!].flatMap((value) =>
			abi.has(value) ? [abi.get(value)!] : [],
		);
		const rightAbi = [...members.get(rightRoot)!].flatMap((value) =>
			abi.has(value) ? [abi.get(value)!] : [],
		);
		if (leftAbi.length > 0 && rightAbi.length > 0 && leftAbi[0] !== rightAbi[0]) {
			return false;
		}
		if (
			[...members.get(leftRoot)!].some((leftValue) =>
				[...members.get(rightRoot)!].some((rightValue) =>
					interference.get(leftValue)!.has(rightValue),
				),
			)
		) {
			return false;
		}
		parent.set(rightRoot, leftRoot);
		for (const value of members.get(rightRoot)!) members.get(leftRoot)!.add(value);
		members.delete(rightRoot);
		return true;
	};
	for (const block of core.blocks) {
		if (block.id === core.entry || block.parameters[0]?.role === "exception") continue;
		for (const [index, parameter] of block.parameters.entries()) {
			const arguments_ = core.blocks.flatMap((predecessor) =>
				coreTerminatorEdges(predecessor.terminator)
					.filter((edge) => edge.block === block.id)
					.map((edge) => edge.arguments[index]!),
			);
			for (const argument of arguments_) union(parameter.value, argument);
		}
	}
	const roots = new Map<CoreValueId, CoreValueId>(
		core.values.map(({ id }) => [id, find(id)]),
	);
	const rootInterference = new Map<CoreValueId, Set<CoreValueId>>();
	for (const root of new Set(roots.values())) rootInterference.set(root, new Set());
	for (const [value, neighbors] of interference) {
		const root = find(value);
		for (const neighbor of neighbors) {
			const neighborRoot = find(neighbor);
			if (neighborRoot !== root) rootInterference.get(root)!.add(neighborRoot);
		}
	}
	const registers = new Map<CoreValueId, number>();
	const colorRepresentations = new Map<number, CoreRepresentation>();
	for (const [value, color] of abi) {
		const root = find(value);
		const existing = registers.get(root);
		if (existing !== undefined && existing !== color) {
			throw new Error(`Core ABI values with distinct slots merged at %${root}`);
		}
		registers.set(root, color);
		colorRepresentations.set(color, representations.get(root)!);
	}
	let nextUniqueColor = Math.max(-1, ...registers.values()) + 1;
	const orderedRoots = [...rootInterference.keys()].sort(
		(left, right) =>
			(rootInterference.get(right)?.size ?? 0) -
				(rootInterference.get(left)?.size ?? 0) || left - right,
	);
	for (const root of orderedRoots) {
		if (registers.has(root)) continue;
		const representation = representations.get(root)!;
		if (!reuseRegisters) {
			registers.set(root, nextUniqueColor);
			colorRepresentations.set(nextUniqueColor, representation);
			nextUniqueColor++;
			continue;
		}
		const unavailable = new Set(
			[...(rootInterference.get(root) ?? [])].flatMap((neighbor) => {
				const color = registers.get(neighbor);
				return color === undefined ? [] : [color];
			}),
		);
		let color = 0;
		while (
			unavailable.has(color) ||
			(colorRepresentations.has(color) &&
				colorRepresentations.get(color) !== representation)
		) {
			color++;
		}
		registers.set(root, color);
		colorRepresentations.set(color, representation);
		nextUniqueColor = Math.max(nextUniqueColor, color + 1);
	}
	const gcRootValues = new Set<CoreValueId>();
	const loopBackedges = new Set(
		buildCoreControlFlow(core, coreOpcodeRegistry).loops.map(({ backedge }) => backedge),
	);
	for (const block of core.blocks) {
		const live = new Set(liveOut[block.id]);
		for (const parameter of handlerParameters(block)) live.add(parameter);
		if (loopBackedges.has(block.id)) {
			for (const value of live) gcRootValues.add(value);
			for (const value of terminatorValues(block)) gcRootValues.add(value);
		}
		for (let index = block.instructions.length - 1; index >= 0; index--) {
			const instruction = block.instructions[index]!;
			const effects =
				instruction.effectRefinement?.effects ??
				coreOpcodeRegistry.require(instruction.opcode).effects;
			if (effects.mayGc) {
				for (const value of live) gcRootValues.add(value);
				for (const value of instruction.inputs) gcRootValues.add(value);
			}
			for (const output of instruction.outputs) live.delete(output);
			for (const input of instruction.inputs) live.add(input);
		}
		if (block.parameters[0]?.role === "exception") {
			for (const value of live) gcRootValues.add(value);
			gcRootValues.add(block.parameters[0].value);
		}
	}
	const gcRootRegisters = [
		...new Set([...gcRootValues].map((value) => registers.get(find(value))!)),
	].sort((left, right) => left - right);
	return {
		roots,
		registers,
		gcRootRegisters,
		registerRepresentations: colorRepresentations,
	};
}

function coreRegionInstructionIds(core: CoreFunction): ReadonlySet<CoreInstructionId> {
	const result = new Set<CoreInstructionId>();
	const visit = (value: unknown): void => {
		if (value === undefined || value === null || typeof value !== "object") return;
		if (Array.isArray(value)) {
			for (const entry of value) visit(entry);
			return;
		}
		const object = value as Readonly<Record<string, unknown>>;
		if (Object.keys(object).length === 1 && typeof object.$coreInstruction === "number") {
			result.add(object.$coreInstruction as CoreInstructionId);
			return;
		}
		for (const entry of Object.values(object)) visit(entry);
	};
	for (const region of core.regions) {
		for (const id of region.anchors) result.add(id);
		for (const id of region.claimedInstructions) result.add(id);
		visit(region.data);
	}
	return result;
}

function immediateOnlyInstructions(
	core: CoreFunction,
	protectedInstructions: ReadonlySet<CoreInstructionId>,
): ReadonlySet<CoreInstructionId> {
	const embedded = new Set<CoreValueId>();
	const ordinary = new Set<CoreValueId>();
	for (const block of core.blocks) {
		for (const instruction of block.instructions) {
			for (const input of instruction.inputs) {
				if (
					(instruction.opcode === "call" || instruction.opcode === "construct") &&
					coreImmediateValue(core, input) !== undefined
				) {
					embedded.add(input);
				} else {
					ordinary.add(input);
				}
			}
		}
		const ordinaryTerminatorUse = (value: CoreValueId): void => {
			ordinary.add(value);
		};
		switch (block.terminator.kind) {
			case "branch":
			case "guard":
				ordinaryTerminatorUse(block.terminator.condition);
				break;
			case "switch":
				ordinaryTerminatorUse(block.terminator.discriminant);
				break;
			case "return":
			case "throw":
				ordinaryTerminatorUse(block.terminator.value);
				break;
			case "jump":
			case "unreachable":
				break;
		}
		for (const edge of coreTerminatorEdges(block.terminator)) {
			for (const argument of edge.arguments) ordinaryTerminatorUse(argument);
		}
		for (const argument of block.handler?.arguments ?? [])
			ordinaryTerminatorUse(argument);
	}
	return new Set(
		core.blocks.flatMap((block) =>
			block.instructions.flatMap((instruction) =>
				!protectedInstructions.has(instruction.id) &&
				instruction.outputs.length > 0 &&
				instruction.outputs.every(
					(output) => embedded.has(output) && !ordinary.has(output),
				)
					? [instruction.id]
					: [],
			),
		),
	);
}

function coreBlockLayout(
	core: CoreFunction,
	omitted: ReadonlySet<CoreBlockId>,
): Array<CoreBlockId> {
	const forwardingTarget = (block: CoreBlockId): CoreBlockId => {
		let current = block;
		const seen = new Set<CoreBlockId>();
		while (omitted.has(current)) {
			if (seen.has(current)) throw new Error(`Cyclic omitted Core block b${current}`);
			seen.add(current);
			const forwarding = core.blocks[current]!;
			if (forwarding.terminator.kind !== "jump") {
				throw new Error(`Omitted Core block b${current} is not a forwarding block`);
			}
			current = forwarding.terminator.edge.block;
		}
		return current;
	};
	const successors = (block: CoreFunction["blocks"][number]): Array<CoreBlockId> => {
		const exceptional =
			block.handler === undefined ? [] : [forwardingTarget(block.handler.block)];
		switch (block.terminator.kind) {
			case "jump":
				return [...exceptional, forwardingTarget(block.terminator.edge.block)];
			case "branch":
				return [
					...exceptional,
					forwardingTarget(block.terminator.alternate.block),
					forwardingTarget(block.terminator.consequent.block),
				];
			case "guard":
				return [
					...exceptional,
					forwardingTarget(block.terminator.fallback.block),
					forwardingTarget(block.terminator.success.block),
				];
			case "switch":
				return [
					...exceptional,
					forwardingTarget(block.terminator.default.block),
					...block.terminator.cases
						.toReversed()
						.map(({ edge }) => forwardingTarget(edge.block)),
				];
			case "return":
			case "throw":
			case "unreachable":
				return exceptional;
		}
	};

	const visited = new Set<CoreBlockId>();
	const order: Array<CoreBlockId> = [];
	const visit = (start: CoreBlockId): void => {
		if (omitted.has(start) || visited.has(start)) return;
		const postorder: Array<CoreBlockId> = [];
		visited.add(start);
		const stack: Array<{
			readonly block: CoreBlockId;
			readonly successors: ReadonlyArray<CoreBlockId>;
			index: number;
		}> = [{ block: start, successors: successors(core.blocks[start]!), index: 0 }];
		while (stack.length > 0) {
			const frame = stack.at(-1)!;
			if (frame.index >= frame.successors.length) {
				postorder.push(frame.block);
				stack.pop();
				continue;
			}
			const next = frame.successors[frame.index++]!;
			if (omitted.has(next) || visited.has(next)) continue;
			visited.add(next);
			stack.push({ block: next, successors: successors(core.blocks[next]!), index: 0 });
		}
		order.push(...postorder.toReversed());
	};
	visit(core.entry);
	for (const block of core.blocks) visit(block.id);
	return order;
}

interface LoweredCoreFunction {
	readonly fn: CoreTargetFunction;
	readonly gcRootRegisters: ReadonlyArray<number>;
}

function lowerFunctionToTarget(
	core: CoreFunction,
	instructionSites?: WeakMap<object, CompilerSiteFacts>,
	reuseRegisters = true,
): LoweredCoreFunction {
	verifyCoreFunction(core, coreOpcodeRegistry);
	const loweredInstructions = new Map<CoreInstructionId, CompilerInstruction>();
	const protectedInstructions = coreRegionInstructionIds(core);
	const omittedInstructions = immediateOnlyInstructions(core, protectedInstructions);
	const predecessorCounts = core.blocks.map(() => 0);
	for (const block of core.blocks) {
		for (const edge of coreTerminatorEdges(block.terminator)) {
			predecessorCounts[edge.block]!++;
		}
		if (block.handler !== undefined) predecessorCounts[block.handler.block]!++;
	}
	const absorbedAlternateBlocks = new Set<CoreBlockId>();
	for (const block of core.blocks) {
		const alternate =
			block.terminator.kind === "branch"
				? block.terminator.alternate
				: block.terminator.kind === "guard"
					? block.terminator.fallback
					: undefined;
		if (alternate === undefined) continue;
		const forwarding = core.blocks[alternate.block]!;
		if (
			predecessorCounts[forwarding.id] === 1 &&
			forwarding.id !== core.entry &&
			forwarding.id !== core.bodyEntry &&
			forwarding.parameters[0]?.role !== "exception" &&
			forwarding.instructions.length === 0 &&
			forwarding.handler === undefined &&
			forwarding.terminator.kind === "jump"
		) {
			absorbedAlternateBlocks.add(forwarding.id);
		}
	}
	const blockOrder = coreBlockLayout(core, absorbedAlternateBlocks);
	const loweredBlockForCore = new Map<CoreBlockId, number>(
		blockOrder.map((block, index) => [block, index]),
	);
	const blocks: Array<{ instructions: Array<CompilerInstruction> }> = blockOrder.map(
		() => ({ instructions: [] }),
	);
	const {
		roots,
		registers: allocatedRegisters,
		gcRootRegisters,
		registerRepresentations,
	} = coreRegisterClasses(core, reuseRegisters);
	const nextRegister = {
		value: Math.max(-1, ...allocatedRegisters.values()) + 1,
	};
	const registerForValue = (value: CoreValueId): number => {
		const root = roots.get(value)!;
		let register = allocatedRegisters.get(root);
		if (register === undefined) {
			register = nextRegister.value++;
			allocatedRegisters.set(root, register);
			registerRepresentations.set(register, core.values[root]!.representation);
		}
		return register;
	};

	const edgeBlock = (edge: CoreEdge): number => {
		const target = core.blocks[edge.block]!;
		const loweredTarget = loweredBlockForCore.get(edge.block);
		if (loweredTarget === undefined) {
			throw new Error(`Ordinary Core edge targets omitted block ${edge.block}`);
		}
		if (target.parameters[0]?.role === "exception") {
			throw new Error(`Ordinary Core edge targets exception block ${edge.block}`);
		}
		const instructions = parallelMoves(
			target.parameters.map((parameter, index) => ({
				destination: registerForValue(parameter.value),
				source: registerForValue(edge.arguments[index]!),
			})),
			nextRegister,
			registerRepresentations,
		);
		if (instructions.length === 0) return loweredTarget;
		const index = blocks.length;
		blocks.push({
			instructions: [...instructions, { type: "jump", blocks: [loweredTarget] }],
		});
		return index;
	};
	const absorbAlternate = (
		edge: CoreEdge,
	): { readonly edge: CoreEdge; readonly terminator: CoreInstructionId } | undefined => {
		if (!absorbedAlternateBlocks.has(edge.block)) return undefined;
		const forwarding = core.blocks[edge.block]!;
		if (forwarding.terminator.kind !== "jump") return undefined;
		const substitutions = new Map(
			forwarding.parameters.map((parameter, index) => [
				parameter.value,
				edge.arguments[index]!,
			]),
		);
		return {
			edge: {
				block: forwarding.terminator.edge.block,
				arguments: forwarding.terminator.edge.arguments.map(
					(argument) => substitutions.get(argument) ?? argument,
				),
			},
			terminator: forwarding.terminator.id,
		};
	};
	const nextEmittedBlock = (block: CoreBlockId): number | undefined => {
		const lowered = loweredBlockForCore.get(block);
		return lowered === undefined || lowered + 1 >= blockOrder.length
			? undefined
			: lowered + 1;
	};

	for (const coreBlock of blockOrder) {
		const block = core.blocks[coreBlock]!;
		const loweredBlock = loweredBlockForCore.get(block.id)!;
		const instructions = blocks[loweredBlock]!.instructions;
		if (block.handler !== undefined) {
			const target = core.blocks[block.handler.block]!;
			const loweredHandler = loweredBlockForCore.get(block.handler.block);
			if (loweredHandler === undefined) {
				throw new Error(`Core handler targets omitted block ${block.handler.block}`);
			}
			const explicitParameters = target.parameters.slice(1);
			instructions.push({
				type: "tryBegin",
				blocks: [loweredHandler, loweredBlock],
			});
			instructions.push(
				...parallelMoves(
					explicitParameters.map((parameter, index) => ({
						destination: registerForValue(parameter.value),
						source: registerForValue(block.handler!.arguments[index]!),
					})),
					nextRegister,
					registerRepresentations,
				),
			);
		}
		if (block.parameters[0]?.role === "exception") {
			instructions.push({
				type: "catch",
				registers: [registerForValue(block.parameters[0].value)],
			});
		}
		for (const instruction of block.instructions) {
			if (omittedInstructions.has(instruction.id)) continue;
			instructions.push(...sourcePositionMarker(instruction.sourcePosition));
			const lowered = rebuildInstruction(core, instruction, registerForValue);
			const compilerSite = instructionSites?.get(instruction);
			if (compilerSite !== undefined) instructionSites?.set(lowered, compilerSite);
			let resultMove: CompilerInstruction | undefined;
			if (lowered.type === "constructSuperExplicit") {
				// Core models current-this as an ordinary SSA input. The compact VM op is
				// two-address. A fresh register is required when the allocated result and
				// current-this differ: reusing the result register for the input can clobber
				// another live operand, such as the parent constructor.
				const destination = lowered.registers[0];
				const currentThis = lowered.registers[4];
				if (destination !== currentThis) {
					const constrained = nextRegister.value++;
					registerRepresentations.set(constrained, "boxed");
					instructions.push({
						type: "move",
						registers: [constrained, currentThis],
					});
					lowered.registers[0] = constrained;
					lowered.registers[4] = constrained;
					resultMove = {
						type: "move",
						registers: [destination, constrained],
					};
				} else {
					lowered.registers[4] = destination;
				}
			}
			instructions.push(lowered);
			if (resultMove !== undefined) instructions.push(resultMove);
			loweredInstructions.set(instruction.id, lowered);
		}
		instructions.push(...sourcePositionMarker(block.terminator.sourcePosition));
		switch (block.terminator.kind) {
			case "jump":
				{
					const target = edgeBlock(block.terminator.edge);
					if (
						block.handler !== undefined &&
						!protectedInstructions.has(block.terminator.id) &&
						target === nextEmittedBlock(block.id)
					) {
						break;
					}
					const lowered: CompilerInstruction = {
						type: "jump",
						blocks: [target],
					};
					instructions.push(lowered);
					loweredInstructions.set(block.terminator.id, lowered);
				}
				break;
			case "branch":
				{
					const absorbed = absorbAlternate(block.terminator.alternate);
					const lowered: CompilerInstruction = {
						type: "jumpIf",
						registers: [registerForValue(block.terminator.condition)],
						blocks: [edgeBlock(block.terminator.consequent)],
					};
					const alternate: CompilerInstruction = {
						type: "jump",
						blocks: [edgeBlock(absorbed?.edge ?? block.terminator.alternate)],
					};
					instructions.push(lowered, alternate);
					loweredInstructions.set(block.terminator.id, lowered);
					if (absorbed !== undefined) {
						loweredInstructions.set(absorbed.terminator, alternate);
					}
				}
				break;
			case "guard":
				{
					const absorbed = absorbAlternate(block.terminator.fallback);
					const lowered: CompilerInstruction = {
						type: "jumpIf",
						registers: [registerForValue(block.terminator.condition)],
						blocks: [edgeBlock(block.terminator.success)],
					};
					const fallback: CompilerInstruction = {
						type: "jump",
						blocks: [edgeBlock(absorbed?.edge ?? block.terminator.fallback)],
					};
					instructions.push(lowered, fallback);
					loweredInstructions.set(block.terminator.id, lowered);
					if (absorbed !== undefined) {
						loweredInstructions.set(absorbed.terminator, fallback);
					}
				}
				break;
			case "return":
			case "throw":
				{
					const lowered: CompilerInstruction = {
						type: block.terminator.kind,
						registers: [registerForValue(block.terminator.value)],
					};
					instructions.push(lowered);
					loweredInstructions.set(block.terminator.id, lowered);
				}
				break;
			case "switch":
				for (const switchCase of block.terminator.cases) {
					const immediate = nextRegister.value++;
					const matches = nextRegister.value++;
					registerRepresentations.set(
						immediate,
						switchCase.value.kind === "number"
							? "f64"
							: switchCase.value.kind === "boolean"
								? "boolean"
								: "boxed",
					);
					registerRepresentations.set(matches, "boolean");
					instructions.push(
						lowerCoreImmediate(switchCase.value, immediate),
						{
							type: "binary",
							registers: [
								matches,
								registerForValue(block.terminator.discriminant),
								immediate,
							],
							operator: "===",
						},
						{
							type: "jumpIf",
							registers: [matches],
							blocks: [edgeBlock(switchCase.edge)],
						},
					);
				}
				instructions.push({
					type: "jump",
					blocks: [edgeBlock(block.terminator.default)],
				});
				break;
			case "unreachable":
				throw new Error(`Reachable Core block ${block.id} ends in unreachable`);
		}
		if (block.handler !== undefined) instructions.push({ type: "tryEnd" });
	}

	const physicalRepresentations = Array.from(
		{ length: nextRegister.value },
		(_, register): "boxed" | "number" | "boolean" => {
			const representation = registerRepresentations.get(register);
			if (representation === undefined) {
				throw new Error(`Core allocation left r${register} without a representation`);
			}
			return representation === "f64" || representation === "i32"
				? "number"
				: representation === "boolean"
					? "boolean"
					: "boxed";
		},
	);
	return {
		fn: {
			sourcePath: core.metadata.sourcePath,
			functionIndex: core.functionIndex,
			nameStringIndex: core.metadata.nameStringIndex,
			blocks,
			regions: lowerCoreRegions(
				core.regions,
				loweredInstructions,
				absorbedAlternateBlocks,
				loweredBlockForCore,
				new Map(core.values.map(({ id }) => [id, registerForValue(id)])),
			),
			isGenerator: core.isGenerator,
			isAsync: core.isAsync,
			parameterCount: core.parameters.length,
			mappedArgumentSlots: [...core.metadata.mappedArgumentSlots],
			mappedArguments: core.metadata.mappedArguments,
			length: core.metadata.length,
			registerCount: nextRegister.value,
			registerRepresentations: physicalRepresentations,
			capturedCount: core.metadata.capturedCount,
			strict: core.metadata.strict,
			isClassConstructor: core.metadata.isClassConstructor,
			isDerivedConstructor: core.metadata.isDerivedConstructor,
			hasPrototype: core.metadata.hasPrototype,
		},
		gcRootRegisters,
	};
}

/** Select and allocate canonical Core into the VM target form. */
export interface LowerCoreToTargetOptions {
	readonly reuseRegisters?: boolean;
}

export function lowerCoreProgramToTarget(
	core: CoreProgram,
	options: LowerCoreToTargetOptions = {},
): CoreTargetProgram {
	const compilation = core.compilation;
	if (compilation === undefined) {
		throw new Error("Core program is missing product compilation metadata");
	}
	const lowered = core.functions.map((fn) =>
		lowerFunctionToTarget(
			fn,
			compilation.facts.instructionSites,
			options.reuseRegisters ?? true,
		),
	);
	return {
		core,
		functions: lowered.map(({ fn }) => fn),
		gcRootRegisters: lowered.map(({ gcRootRegisters }, index) =>
			core.functions[index]!.isGenerator || core.functions[index]!.isAsync
				? undefined
				: gcRootRegisters,
		),
	};
}
