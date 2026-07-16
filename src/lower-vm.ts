import type { IntermediateProgram, IRFunction, IRInstruction } from "./ir.ts";
import { computeSafepointRoots } from "./liveness.ts";
import type { Binding } from "./semantic-analysis.ts";

type IRBinaryOperator = Extract<IRInstruction, { type: "binary" }>["operator"];
type IRUnaryOperator = Extract<IRInstruction, { type: "unary" }>["operator"];
type IRIntrinsic = Extract<IRInstruction, { type: "loadIntrinsic" }>["intrinsic"];

/**
 * Keep inline with the C struct
 */
export interface VmDefinition {
	functionCount: number;
	functions: Array<VmFunction>;
	stringConstants: Array<Array<number>>;
	bigintConstants: Array<bigint>;
	literalTemplateData: Array<number>;
	globalCount: number;

	/**
	 * Debug-info file table: file id -> source path (relative to the compiler's
	 * working directory). A function's `fileIndex` points here; the runtime
	 * prefixes each with `compiled://` for stack-trace frames.
	 */
	files: Array<string>;

	/**
	 * Debug-info position table: pos id -> (line, column), shared by all
	 * functions (the file is resolved per-function). A function's per-instruction
	 * `positions` index into this.
	 */
	sourcePositions: Array<{
		line: number;
		column: number;
		inlinedFunctionIndex?: number;
		callerPosId?: number;
	}>;

	/**
	 * CommonJS module table: index (module id) -> wrapper function index. Empty
	 * for programs with no CommonJS modules.
	 */
	cjsModuleFunctionIndices: Array<number>;

	/**
	 * Host-install manifest: for each `node:*` built-in whose exports the program
	 * uses, plus the slot-free global `process` installer, the native installer's C
	 * symbol and any global slots it fills. Dead-code elimination drops unused
	 * entries, so an ordinary program's manifest is empty. Installers run after VM
	 * init / host attach and before execution; a definition decoded from the wire
	 * keeps the same name/slot entries but its installer pointer is unresolved (null).
	 */
	hostInstalls: Array<{
		installer: string;
		exports: Array<{ name: string; slot: number }>;
	}>;
}

/**
 * Keep inline with the C struct
 */
export interface VmExceptionHandler {
	startIp: number;
	endIp: number;
	handlerIp: number;
}

/**
 * Keep inline with the C struct
 */
export interface VmFunction {
	nameStringIndex: number;
	isGenerator: boolean;
	isAsync: boolean;
	parameterCount: number;
	length: number;
	registerCount: number;
	capturedCount: number;
	strict: boolean;

	/**
	 * Whether the function ever reads its passed arguments through the frame —
	 * i.e. it materializes an `arguments` object or collects a rest parameter.
	 * When false the activation skips allocating/copying the arguments slice.
	 */
	needsArguments: boolean;

	/**
	 * A derived class constructor: `this` starts uninitialized (TDZ) and is bound
	 * only by super(), so the construct site allocates no eager `this` and reads
	 * of `this` before super() throw ReferenceError.
	 */
	isDerivedConstructor: boolean;

	/**
	 * A class constructor (base or derived): its `prototype` property is
	 * non-writable (MakeConstructor with writablePrototype = false), unlike a
	 * normal function's writable prototype.
	 */
	isClassConstructor: boolean;

	/**
	 * Whether this function owns a `prototype` property. False for methods,
	 * getters, setters and arrows (not constructors); true for normal functions,
	 * class constructors and generators. (Async non-generators are excluded at
	 * runtime by kind.)
	 */
	hasPrototype: boolean;

	instructions: Array<VmInstruction>;
	handlers: Array<VmExceptionHandler>;

	/**
	 * Debug-info: index into VmDefinition.files for this function's source file.
	 */
	fileIndex: number;

	/**
	 * Debug-info: parallel to `instructions` — positions[i] is the source-position
	 * id (index into VmDefinition.sourcePositions) of instruction i, or -1 when
	 * unknown (e.g. prologue code before the first statement marker). Built from
	 * the stripped `sourcePos` markers. The VM resolves a frame's position by its
	 * instruction pointer; the native backend emits coalesced `pos` writes from it.
	 */
	positions: Array<number>;

	/**
	 * COMPILE-ONLY (not part of the C `MalFunction` struct): the registers the
	 * native backend must spill into this function's GC root frame — those live at
	 * or used by a GC safepoint (`computeSafepointRoots`), already
	 * in this function's post-allocation register numbering. emit-c roots exactly
	 * the boxed registers in this set; a register absent from it never holds a live
	 * value at a collection point. Undefined for generator/async functions (the
	 * native backend bails on those) — emit-c then falls back to rooting every
	 * boxed register.
	 */
	gcRootRegisters?: ReadonlyArray<number>;

	/**
	 * COMPILE-ONLY: exact CREATE_OBJECT_SHAPED instruction sites proven safe for
	 * native stack emission. Omitted by the wire codec, so deserialized/interpreted
	 * functions retain ordinary heap allocation semantics.
	 */
	stackObjectSites?: ReadonlyArray<{ instructionIndex: number; slotCount: number }>;
}

/**
 * Keep inline with the C struct
 */
export type VmInstruction =
	| {
			opcode: "MOVE";
			dst: number;
			src: number;
	  }
	| {
			opcode: "RETURN";
			value: number;
	  }
	| {
			opcode: "JUMP_IF";
			cond: number;
			targetIp: number;
	  }
	| {
			opcode: "JUMP";
			targetIp: number;
	  }
	| {
			opcode: "CREATE_NUMBER";
			dst: number;
			value: number;
	  }
	| {
			opcode: "CREATE_F64";
			dst: number;
			value: number;
	  }
	| {
			opcode: "CREATE_BOOLEAN";
			dst: number;
			value: boolean;
	  }
	| {
			opcode: "CREATE_STRING";
			dst: number;
			stringIndex: number;
	  }
	| {
			opcode: "CREATE_BIGINT";
			dst: number;
			bigintIndex: number;
	  }
	| {
			opcode: "CREATE_OBJECT";
			dst: number;
	  }
	| {
			opcode: "CREATE_OBJECT_SHAPED";
			dst: number;
			count: number;
			keyStringIndices: Array<number>;
			valueRegisters: Array<number>;
	  }
	| {
			opcode: "CREATE_ARRAY";
			dst: number;
			length: number;
	  }
	| {
			opcode: "INSTANTIATE_LITERAL_TEMPLATE";
			dst: number;
			templateOffset: number;
	  }
	| {
			opcode: "CREATE_MODULE_NAMESPACE";
			dst: number;
			nameIndices: Array<number>;
			slots: Array<number>;
	  }
	| {
			opcode: "CREATE_TEMPLATE_OBJECT";
			dst: number;
			cacheSlot: number;
			cookedIndices: Array<number>;
			rawIndices: Array<number>;
	  }
	| {
			opcode: "CREATE_UNDEFINED";
			dst: number;
	  }
	| {
			opcode: "CREATE_EMPTY";
			dst: number;
	  }
	| {
			opcode: "CREATE_NULL";
			dst: number;
	  }
	| {
			opcode: "CREATE_FUNCTION";
			dst: number;
			functionIndex: number;
	  }
	| {
			opcode: "CREATE_ARGUMENTS_OBJECT";
			dst: number;
	  }
	| {
			opcode: "LOAD_ARGUMENT_COUNT";
			dst: number;
	  }
	| {
			opcode: "LOAD_ARGUMENT";
			dst: number;
			index: number;
	  }
	| {
			opcode: "LOAD_THIS";
			dst: number;
	  }
	| {
			opcode: "LOAD_NEW_TARGET";
			dst: number;
	  }
	| {
			opcode: "LOAD_CALLEE";
			dst: number;
	  }
	| {
			opcode: "CALL";
			dst: number;
			callee: number;
			thisValue: number;
			argumentCount: number;
			arguments: Array<number>;
	  }
	| {
			opcode: "CONSTRUCT";
			dst: number;
			callee: number;
			argumentCount: number;
			arguments: Array<number>;
	  }
	| {
			opcode: "THROW";
			value: number;
	  }
	| {
			opcode: "CATCH";
			dst: number;
	  }
	| {
			opcode: "TRY_BEGIN";
			handlerIp: number;
	  }
	| {
			opcode: "TRY_END";
	  }
	| {
			opcode: "GENERATOR_START";
	  }
	| {
			opcode: "ASYNC_START";
	  }
	| {
			opcode: "YIELD";
			yieldedSrc: number;
			valueDst: number;
			modeDst: number;
	  }
	| {
			opcode: "AWAIT";
			awaitedSrc: number;
			valueDst: number;
			modeDst: number;
	  }
	| {
			opcode: "LOAD_INTRINSIC";
			dst: number;
			intrinsic: IRIntrinsic;
	  }
	| {
			opcode: "LOAD_CAPTURED";
			dst: number;
			ownerFunctionIndex: number;
			index: number;
	  }
	| {
			opcode: "GUARD_FUNCTION_INDEX";
			dst: number;
			callee: number;
			functionIndex: number;
	  }
	| {
			opcode: "LOAD_GLOBAL";
			dst: number;
			index: number;
	  }
	| {
			opcode: "STORE_CAPTURED";
			src: number;
			ownerFunctionIndex: number;
			index: number;
	  }
	| {
			opcode: "ENV_PUSH" | "ENV_COPY";
			scopeId: number;
			slotCount: number;
	  }
	| {
			opcode: "ENV_POP";
	  }
	| {
			opcode: "STORE_GLOBAL";
			src: number;
			index: number;
	  }
	| {
			opcode: "LOAD_PROPERTY";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "LOAD_SUPER_PROPERTY";
			dst: number;
			object: number;
			key: number;
			receiver: number;
	  }
	| {
			opcode: "STORE_PROPERTY";
			object: number;
			key: number;
			value: number;
	  }
	| {
			opcode: "TO_PROPERTY_KEY";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "STORE_SUPER_PROPERTY";
			object: number;
			key: number;
			value: number;
			receiver: number;
	  }
	| {
			opcode: "LOAD_PROTOTYPE";
			dst: number;
			object: number;
	  }
	| {
			opcode: "GET_ITERATOR";
			iteratorDst: number;
			nextDst: number;
			source: number;
	  }
	| {
			opcode: "GET_ASYNC_ITERATOR";
			iteratorDst: number;
			nextDst: number;
			source: number;
	  }
	| {
			opcode: "ITERATOR_NEXT";
			resultDst: number;
			iterator: number;
			next: number;
	  }
	| {
			opcode: "ITERATOR_STEP";
			valueDst: number;
			doneDst: number;
			iterator: number;
			next: number;
	  }
	| {
			opcode: "ITERATOR_CLOSE";
			iterator: number;
			normal: boolean;
	  }
	| {
			opcode: "FOR_IN_KEYS";
			dst: number;
			source: number;
	  }
	| {
			opcode: "CALL_SPREAD";
			dst: number;
			callee: number;
			thisValue: number;
			argumentsArray: number;
	  }
	| {
			opcode: "CONSTRUCT_SPREAD";
			dst: number;
			callee: number;
			argumentsArray: number;
	  }
	| {
			opcode: "CONSTRUCT_SUPER";
			dst: number;
			parent: number;
			argumentsArray: number;
	  }
	| {
			opcode: "MERGE_DATA_PROPERTIES";
			target: number;
			src: number;
	  }
	| {
			opcode: "DELETE_PROPERTY";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "DEFINE_ACCESSOR";
			object: number;
			key: number;
			accessor: number;
			isSetter: boolean;
			enumerable: boolean;
	  }
	| {
			opcode: "DEFINE_PROPERTY";
			object: number;
			key: number;
			value: number;
			enumerable: boolean;
	  }
	| {
			opcode: "SET_FUNCTION_NAME";
			func: number;
			key: number;
			// 0 = no prefix, 1 = "get ", 2 = "set ".
			prefix: number;
	  }
	| {
			opcode: "CREATE_PRIVATE_NAME";
			dst: number;
	  }
	| {
			opcode: "DEFINE_PRIVATE";
			object: number;
			key: number;
			value: number;
	  }
	| {
			opcode: "LOAD_PRIVATE";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "STORE_PRIVATE";
			object: number;
			key: number;
			value: number;
	  }
	| {
			opcode: "HAS_PRIVATE";
			dst: number;
			object: number;
			key: number;
	  }
	| {
			opcode: "SET_PROTOTYPE";
			object: number;
			prototype: number;
			literal: boolean;
	  }
	| {
			opcode: "LOAD_UNDECLARED";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "LOAD_GLOBAL_PROPERTY";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "STORE_GLOBAL_PROPERTY";
			src: number;
			nameStringIndex: number;
			declaration: boolean;
			declarationConfigurable: boolean;
	  }
	| {
			opcode: "THROW_IF_TDZ";
			src: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_ENTER";
			object: number;
	  }
	| {
			opcode: "WITH_EXIT";
	  }
	| {
			opcode: "WITH_GET";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_RESOLVE_BASE";
			dst: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "WITH_SET";
			found: number;
			value: number;
			nameStringIndex: number;
	  }
	| {
			opcode: "IS_EMPTY";
			dst: number;
			src: number;
	  }
	| {
			opcode: "REQUIRE_COERCIBLE";
			src: number;
	  }
	| {
			opcode: "CHECK_SUPER_CLASS";
			parent: number;
	  }
	| {
			opcode: "CREATE_REST_ARGUMENTS";
			dst: number;
			startIndex: number;
	  }
	| {
			opcode: "ARRAY_REST";
			dst: number;
			src: number;
			startIndex: number;
	  }
	| {
			opcode: "COPY_DATA_PROPERTIES";
			dst: number;
			src: number;
			excludedCount: number;
			excluded: Array<number>;
	  }
	| {
			opcode: "BINARY";
			dst: number;
			left: number;
			right: number;
			operator: IRBinaryOperator;
	  }
	| {
			opcode: "UNARY";
			dst: number;
			src: number;
			operator: IRUnaryOperator;
	  };

export interface VmDefinitionStats {
	functionCount: number;
	instructionCount: number;
}

/**
 * Run-length compress a function's per-instruction position ids into
 * (start_ip, pos_id) entries: a new entry only where the position changes. The
 * runtime resolves a frame's position by finding the last entry with
 * start_ip <= instruction_pointer. Shared by the C-literal emitter (emit-vm)
 * and the wire serializer (serialize-vm); it lives here, alongside the VM
 * definition types, so the self-hostable serializer cone never imports emit-vm
 * (which pulls node:path + the emit-c native backend).
 */
export function compressPositions(
	positions: Array<number>,
): Array<{ startIp: number; posId: number }> {
	const runs: Array<{ startIp: number; posId: number }> = [];
	for (let ip = 0; ip < positions.length; ++ip) {
		const posId = positions[ip]!;
		if (runs.length === 0 || runs[runs.length - 1]!.posId !== posId) {
			runs.push({ startIp: ip, posId });
		}
	}
	return runs;
}

/**
 * Aggregate code-size metrics for a compiled definition: how many functions
 * were emitted and the total instruction count across all of them.
 */
export function vmDefinitionStats(definition: VmDefinition): VmDefinitionStats {
	let instructionCount = 0;
	for (const fn of definition.functions) {
		instructionCount += fn.instructions.length;
	}

	return { functionCount: definition.functions.length, instructionCount };
}

/**
 * Lower optimized IR to a VM definition that can then be emitted as C.
 */
export function lowerIrProgramToVmDefinition(program: IntermediateProgram): VmDefinition {
	// Build the debug-info file table: distinct source paths in first-seen order.
	const files: Array<string> = [];
	const fileToIndex = new Map<string, number>();
	const fileIndexFor = (path: string): number => {
		const existing = fileToIndex.get(path);
		if (existing !== undefined) {
			return existing;
		}
		const index = files.push(path) - 1;
		fileToIndex.set(path, index);
		return index;
	};
	const functions = program.functions.map((fn) =>
		lowerFunctionToVmFunction(fn, fileIndexFor(fn.semanticFile.path)),
	);

	return {
		functionCount: program.functions.length,
		functions,
		stringConstants: program.stringConstants,
		bigintConstants: program.bigintConstants,
		literalTemplateData: program.literalTemplateData,
		globalCount: program.nextGlobalIndex,
		cjsModuleFunctionIndices: program.cjsWrapperFunctionIndex,
		hostInstalls: buildHostInstalls(program, functions),
		files,
		sourcePositions: program.sourcePositions,
	};
}

/**
 * Resolve the linker's host built-in bindings to global slots read by the final
 * VM instruction stream. Slot assignment can outlive an optimized-away read, so
 * the emitted functions, rather than bindingToStorage alone, determine export
 * retention. Process remains statically retained from global-property analysis.
 */
function buildHostInstalls(
	program: IntermediateProgram,
	functions: Array<VmFunction>,
): VmDefinition["hostInstalls"] {
	const readGlobalSlots = new Set<number>();
	for (const fn of functions) {
		for (const instruction of fn.instructions) {
			if (instruction.opcode === "LOAD_GLOBAL") {
				readGlobalSlots.add(instruction.index);
			} else if (instruction.opcode === "CREATE_MODULE_NAMESPACE") {
				for (const slot of instruction.slots) {
					readGlobalSlots.add(slot);
				}
			} else if (instruction.opcode === "CREATE_TEMPLATE_OBJECT") {
				readGlobalSlots.add(instruction.cacheSlot);
			}
		}
	}

	const globalSlotOf = (binding: Binding): number | null => {
		const location = program.bindingToStorage.get(binding);
		return location?.type === "global" && readGlobalSlots.has(location.index)
			? location.index
			: null;
	};

	const manifest: VmDefinition["hostInstalls"] = [];
	for (const hostModule of program.hostModules) {
		const usedExports: Array<{ name: string; slot: number }> = [];
		for (const { name, binding } of hostModule.exports) {
			const slot = globalSlotOf(binding);
			if (slot !== null) {
				usedExports.push({ name, slot });
			}
		}
		if (usedExports.length > 0) {
			manifest.push({ installer: hostModule.installer, exports: usedExports });
		}
	}

	if (program.hostProcess?.retained) {
		manifest.push({ installer: program.hostProcess.installer, exports: [] });
	}

	return manifest;
}

/**
 * Lower a function to a VM function. Note that we drop blocks and instead move to jumps to
 * absolute instructions.
 */
function lowerFunctionToVmFunction(fn: IRFunction, fileIndex: number): VmFunction {
	// sourcePos markers carry no opcode and are stripped here, so block start IPs
	// must count only the real (non-marker) instructions that survive.
	const blockStartIps = new Map<number, number>();
	let nextInstructionPointer = 0;

	for (let i = 0; i < fn.blocks.length; ++i) {
		blockStartIps.set(i, nextInstructionPointer);
		for (const instruction of fn.blocks[i]!.instructions) {
			if (instruction.type !== "sourcePos") {
				nextInstructionPointer += 1;
			}
		}
	}

	const instructions: Array<VmInstruction> = [];
	const positions: Array<number> = [];
	const stackObjectSites: Array<{ instructionIndex: number; slotCount: number }> = [];
	let currentPos = -1;
	for (const block of fn.blocks) {
		for (const instruction of block.instructions) {
			if (instruction.type === "sourcePos") {
				currentPos = instruction.pos;
				continue;
			}
			const instructionIndex = instructions.length;
			instructions.push(lowerInstructionToVmInstruction(blockStartIps, instruction));
			if (instruction.type === "createObjectShaped" && instruction.stackObject) {
				stackObjectSites.push({
					instructionIndex,
					slotCount: instruction.keyStringIndices.length,
				});
			}
			positions.push(currentPos);
		}
	}

	// These are the only ops that read frame->arguments; if neither appears the
	// activation never needs the arguments slice. Derived from the emitted
	// stream so it can't drift from the actual reads.
	const needsArguments = instructions.some(
		(instruction) =>
			instruction.opcode === "CREATE_ARGUMENTS_OBJECT" ||
			instruction.opcode === "CREATE_REST_ARGUMENTS" ||
			instruction.opcode === "LOAD_ARGUMENT",
	);

	// GC root-frame minimization (C1): the native backend spills only registers
	// live at a safepoint, not every boxed register. The aggregate-only API avoids
	// constructing diagnostic per-safepoint Sets. This runs post-allocation, so a
	// complexity fallback safely returns every physical register. Skipped for
	// generator/async functions, which the native backend does not compile.
	const isResumable = (fn.isGenerator ?? false) || (fn.isAsync ?? false);
	const gcRootRegisters = isResumable
		? undefined
		: [...computeSafepointRoots(fn).registers];

	return {
		nameStringIndex: fn.nameStringIndex,
		isGenerator: fn.isGenerator ?? false,
		isAsync: fn.isAsync ?? false,
		parameterCount: fn.parameterCount,
		length: fn.length,
		registerCount: fn.nextRegisterDestination,
		capturedCount: fn.nextCapturedIndex,
		strict: fn.strict ?? fn.semanticFile.strict,
		needsArguments,
		isDerivedConstructor:
			(fn.classContext?.isConstructor ?? false) &&
			(fn.classContext?.isDerivedConstructor ?? false),
		isClassConstructor: fn.classContext?.isConstructor ?? false,
		hasPrototype: fn.hasPrototype ?? true,
		instructions,
		handlers: collectExceptionHandlers(instructions),
		fileIndex,
		positions,
		gcRootRegisters,
		stackObjectSites: stackObjectSites.length > 0 ? stackObjectSites : undefined,
	};
}

/**
 * Convert the TRY_BEGIN / TRY_END marker positions in the flattened
 * instruction stream into static exception handler ranges. Doing this after
 * flattening keeps the ranges correct under all block-level optimizations.
 */
function collectExceptionHandlers(instructions: Array<VmInstruction>) {
	const handlers: Array<VmExceptionHandler> = [];
	const openRanges: Array<{ startIp: number; handlerIp: number }> = [];

	for (let ip = 0; ip < instructions.length; ++ip) {
		const instruction = instructions[ip]!;
		if (instruction.opcode === "TRY_BEGIN") {
			openRanges.push({ startIp: ip, handlerIp: instruction.handlerIp });
		} else if (instruction.opcode === "TRY_END") {
			const range = openRanges.pop();
			if (!range) {
				throw new Error(`Unbalanced try markers at instruction ${ip}`);
			}

			handlers.push({
				startIp: range.startIp,
				endIp: ip,
				handlerIp: range.handlerIp,
			});
		}
	}

	if (openRanges.length > 0) {
		throw new Error("Unbalanced try markers at end of function");
	}

	return handlers;
}

/**
 * Map the IR to the VM instruction set.
 */
function lowerInstructionToVmInstruction(
	blockStartIps: Map<number, number>,
	instruction: IRInstruction,
): VmInstruction {
	switch (instruction.type) {
		case "sourcePos":
			// Markers are consumed into `positions` and stripped before this point.
			throw new Error("sourcePos marker must be stripped before lowering");
		case "move":
			return {
				opcode: "MOVE",
				dst: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "return":
			return {
				opcode: "RETURN",
				value: instruction.registers[0],
			};
		case "jumpIf": {
			const targetIp = blockStartIps.get(instruction.blocks[0]);
			if (targetIp === undefined) {
				throw new Error(`Unknown jump target block ${instruction.blocks[0]}`);
			}

			return {
				opcode: "JUMP_IF",
				cond: instruction.registers[0],
				targetIp,
			};
		}
		case "jump": {
			const targetIp = blockStartIps.get(instruction.blocks[0]);
			if (targetIp === undefined) {
				throw new Error(`Unknown jump target block ${instruction.blocks[0]}`);
			}

			return {
				opcode: "JUMP",
				targetIp,
			};
		}
		case "createNumber":
			return {
				opcode: "CREATE_NUMBER",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createF64":
			return {
				opcode: "CREATE_F64",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createBoolean":
			return {
				opcode: "CREATE_BOOLEAN",
				dst: instruction.registers[0],
				value: instruction.value,
			};
		case "createString":
			return {
				opcode: "CREATE_STRING",
				dst: instruction.registers[0],
				stringIndex: instruction.stringIndex,
			};
		case "createBigint":
			return {
				opcode: "CREATE_BIGINT",
				dst: instruction.registers[0],
				bigintIndex: instruction.bigintIndex,
			};
		case "createObject":
			return {
				opcode: "CREATE_OBJECT",
				dst: instruction.registers[0],
			};
		case "createObjectShaped":
			return {
				opcode: "CREATE_OBJECT_SHAPED",
				dst: instruction.registers[0],
				count: instruction.registers.length - 1,
				keyStringIndices: instruction.keyStringIndices,
				valueRegisters: instruction.registers.slice(1),
			};
		case "createArray":
			return {
				opcode: "CREATE_ARRAY",
				dst: instruction.registers[0],
				length: instruction.length,
			};
		case "instantiateLiteralTemplate":
			return {
				opcode: "INSTANTIATE_LITERAL_TEMPLATE",
				dst: instruction.registers[0],
				templateOffset: instruction.templateOffset,
			};
		case "createModuleNamespace":
			return {
				opcode: "CREATE_MODULE_NAMESPACE",
				dst: instruction.registers[0],
				nameIndices: instruction.exports.map((entry) => entry.nameStringIndex),
				slots: instruction.exports.map((entry) => entry.slot),
			};
		case "createTemplateObject":
			return {
				opcode: "CREATE_TEMPLATE_OBJECT",
				dst: instruction.registers[0],
				cacheSlot: instruction.cacheSlot,
				cookedIndices: instruction.cookedIndices,
				rawIndices: instruction.rawIndices,
			};
		case "createUndefined":
			return {
				opcode: "CREATE_UNDEFINED",
				dst: instruction.registers[0],
			};
		case "createEmpty":
			return {
				opcode: "CREATE_EMPTY",
				dst: instruction.registers[0],
			};
		case "createNull":
			return {
				opcode: "CREATE_NULL",
				dst: instruction.registers[0],
			};
		case "createFunction":
			return {
				opcode: "CREATE_FUNCTION",
				dst: instruction.registers[0],
				functionIndex: instruction.functionIndex,
			};
		case "createArgumentsObject":
			return {
				opcode: "CREATE_ARGUMENTS_OBJECT",
				dst: instruction.registers[0],
			};
		case "loadArgumentCount":
			return {
				opcode: "LOAD_ARGUMENT_COUNT",
				dst: instruction.registers[0],
			};
		case "loadArgument":
			return {
				opcode: "LOAD_ARGUMENT",
				dst: instruction.registers[0],
				index: instruction.index,
			};
		case "loadThis":
			return {
				opcode: "LOAD_THIS",
				dst: instruction.registers[0],
			};
		case "loadNewTarget":
			return {
				opcode: "LOAD_NEW_TARGET",
				dst: instruction.registers[0],
			};
		case "guardFunctionIndex":
			return {
				opcode: "GUARD_FUNCTION_INDEX",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				functionIndex: instruction.functionIndex,
			};
		case "loadCallee":
			return {
				opcode: "LOAD_CALLEE",
				dst: instruction.registers[0],
			};
		case "call":
			return {
				opcode: "CALL",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				thisValue: instruction.registers[2],
				argumentCount: instruction.registers.length - 3,
				arguments: instruction.registers.slice(3),
			};
		case "construct":
			return {
				opcode: "CONSTRUCT",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				argumentCount: instruction.registers.length - 2,
				arguments: instruction.registers.slice(2),
			};
		case "throw":
			return {
				opcode: "THROW",
				value: instruction.registers[0],
			};
		case "catch":
			return {
				opcode: "CATCH",
				dst: instruction.registers[0],
			};
		case "tryBegin": {
			const handlerIp = blockStartIps.get(instruction.blocks[0]);
			if (handlerIp === undefined) {
				throw new Error(`Unknown handler target block ${instruction.blocks[0]}`);
			}

			return {
				opcode: "TRY_BEGIN",
				handlerIp,
			};
		}
		case "tryEnd":
			return {
				opcode: "TRY_END",
			};
		case "generatorStart":
			return {
				opcode: "GENERATOR_START",
			};
		case "asyncStart":
			return {
				opcode: "ASYNC_START",
			};
		case "yield":
			return {
				opcode: "YIELD",
				valueDst: instruction.registers[0],
				modeDst: instruction.registers[1],
				yieldedSrc: instruction.registers[2],
			};
		case "await":
			return {
				opcode: "AWAIT",
				valueDst: instruction.registers[0],
				modeDst: instruction.registers[1],
				awaitedSrc: instruction.registers[2],
			};
		case "loadIntrinsic":
			return {
				opcode: "LOAD_INTRINSIC",
				dst: instruction.registers[0],
				intrinsic: instruction.intrinsic,
			};
		case "loadCaptured":
			return {
				opcode: "LOAD_CAPTURED",
				dst: instruction.registers[0],
				ownerFunctionIndex: getInstructionFunctionIndex({
					type: instruction.type,
					functionIndex: instruction.functionIndex,
				}),
				index: instruction.index,
			};
		case "storeCaptured":
			return {
				opcode: "STORE_CAPTURED",
				src: instruction.registers[0],
				ownerFunctionIndex: getInstructionFunctionIndex({
					type: instruction.type,
					functionIndex: instruction.functionIndex,
				}),
				index: instruction.index,
			};
		case "envPush":
			return {
				opcode: "ENV_PUSH",
				scopeId: instruction.scopeId,
				slotCount: instruction.slotCount,
			};
		case "envCopy":
			return {
				opcode: "ENV_COPY",
				scopeId: instruction.scopeId,
				slotCount: instruction.slotCount,
			};
		case "envPop":
			return { opcode: "ENV_POP" };
		case "loadGlobal":
			return {
				opcode: "LOAD_GLOBAL",
				dst: instruction.registers[0],
				index: instruction.index,
			};
		case "storeGlobal":
			return {
				opcode: "STORE_GLOBAL",
				src: instruction.registers[0],
				index: instruction.index,
			};
		case "loadProperty":
			return {
				opcode: "LOAD_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "loadSuperProperty":
			return {
				opcode: "LOAD_SUPER_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
				receiver: instruction.registers[3],
			};
		case "storeProperty":
			return {
				opcode: "STORE_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
			};
		case "toPropertyKey":
			return {
				opcode: "TO_PROPERTY_KEY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "storeSuperProperty":
			return {
				opcode: "STORE_SUPER_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
				receiver: instruction.registers[3],
			};
		case "loadPrototype":
			return {
				opcode: "LOAD_PROTOTYPE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
			};
		case "getIterator":
			return {
				opcode: "GET_ITERATOR",
				iteratorDst: instruction.registers[0],
				nextDst: instruction.registers[1],
				source: instruction.registers[2],
			};
		case "getAsyncIterator":
			return {
				opcode: "GET_ASYNC_ITERATOR",
				iteratorDst: instruction.registers[0],
				nextDst: instruction.registers[1],
				source: instruction.registers[2],
			};
		case "iteratorNext":
			return {
				opcode: "ITERATOR_NEXT",
				resultDst: instruction.registers[0],
				iterator: instruction.registers[1],
				next: instruction.registers[2],
			};
		case "iteratorStep":
			return {
				opcode: "ITERATOR_STEP",
				valueDst: instruction.registers[0],
				doneDst: instruction.registers[1],
				iterator: instruction.registers[2],
				next: instruction.registers[3],
			};
		case "iteratorClose":
			return {
				opcode: "ITERATOR_CLOSE",
				iterator: instruction.registers[0],
				normal: instruction.normal === true,
			};
		case "forInKeys":
			return {
				opcode: "FOR_IN_KEYS",
				dst: instruction.registers[0],
				source: instruction.registers[1],
			};
		case "callSpread":
			return {
				opcode: "CALL_SPREAD",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				thisValue: instruction.registers[2],
				argumentsArray: instruction.registers[3],
			};
		case "constructSpread":
			return {
				opcode: "CONSTRUCT_SPREAD",
				dst: instruction.registers[0],
				callee: instruction.registers[1],
				argumentsArray: instruction.registers[2],
			};
		case "constructSuper":
			return {
				opcode: "CONSTRUCT_SUPER",
				dst: instruction.registers[0],
				parent: instruction.registers[1],
				argumentsArray: instruction.registers[2],
			};
		case "mergeDataProperties":
			return {
				opcode: "MERGE_DATA_PROPERTIES",
				target: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "deleteProperty":
			return {
				opcode: "DELETE_PROPERTY",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "defineAccessor":
			return {
				opcode: "DEFINE_ACCESSOR",
				object: instruction.registers[0],
				key: instruction.registers[1],
				accessor: instruction.registers[2],
				isSetter: instruction.kind === "set",
				enumerable: instruction.enumerable,
			};
		case "defineProperty":
			return {
				opcode: "DEFINE_PROPERTY",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
				enumerable: instruction.enumerable,
			};
		case "setFunctionName":
			return {
				opcode: "SET_FUNCTION_NAME",
				func: instruction.registers[0],
				key: instruction.registers[1],
				prefix:
					instruction.namePrefix === "get" ? 1 : instruction.namePrefix === "set" ? 2 : 0,
			};
		case "createPrivateName":
			return {
				opcode: "CREATE_PRIVATE_NAME",
				dst: instruction.registers[0],
			};
		case "definePrivate":
			return {
				opcode: "DEFINE_PRIVATE",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
			};
		case "loadPrivate":
			return {
				opcode: "LOAD_PRIVATE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "storePrivate":
			return {
				opcode: "STORE_PRIVATE",
				object: instruction.registers[0],
				key: instruction.registers[1],
				value: instruction.registers[2],
			};
		case "hasPrivate":
			return {
				opcode: "HAS_PRIVATE",
				dst: instruction.registers[0],
				object: instruction.registers[1],
				key: instruction.registers[2],
			};
		case "setPrototype":
			return {
				opcode: "SET_PROTOTYPE",
				object: instruction.registers[0],
				prototype: instruction.registers[1],
				literal: instruction.literal,
			};
		case "loadUndeclared":
			return {
				opcode: "LOAD_UNDECLARED",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "loadGlobalProperty":
			return {
				opcode: "LOAD_GLOBAL_PROPERTY",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "storeGlobalProperty":
			return {
				opcode: "STORE_GLOBAL_PROPERTY",
				src: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
				declaration: instruction.declaration ?? false,
				declarationConfigurable: instruction.declarationConfigurable ?? false,
			};
		case "throwIfTdz":
			return {
				opcode: "THROW_IF_TDZ",
				src: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withEnter":
			return {
				opcode: "WITH_ENTER",
				object: instruction.registers[0],
			};
		case "withExit":
			return { opcode: "WITH_EXIT" };
		case "withGet":
			return {
				opcode: "WITH_GET",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withResolveBase":
			return {
				opcode: "WITH_RESOLVE_BASE",
				dst: instruction.registers[0],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "withSet":
			return {
				opcode: "WITH_SET",
				found: instruction.registers[0],
				value: instruction.registers[1],
				nameStringIndex: instruction.nameStringIndex,
			};
		case "isEmpty":
			return {
				opcode: "IS_EMPTY",
				dst: instruction.registers[0],
				src: instruction.registers[1],
			};
		case "requireCoercible":
			return {
				opcode: "REQUIRE_COERCIBLE",
				src: instruction.registers[0],
			};
		case "checkSuperClass":
			return {
				opcode: "CHECK_SUPER_CLASS",
				parent: instruction.registers[0],
			};
		case "createRestArguments":
			return {
				opcode: "CREATE_REST_ARGUMENTS",
				dst: instruction.registers[0],
				startIndex: instruction.startIndex,
			};
		case "arrayRest":
			return {
				opcode: "ARRAY_REST",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				startIndex: instruction.startIndex,
			};
		case "copyDataProperties":
			return {
				opcode: "COPY_DATA_PROPERTIES",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				excludedCount: instruction.registers.length - 2,
				excluded: instruction.registers.slice(2),
			};
		case "binary":
			return {
				opcode: "BINARY",
				dst: instruction.registers[0],
				left: instruction.registers[1],
				right: instruction.registers[2],
				operator: instruction.operator,
			};
		case "unary":
			return {
				opcode: "UNARY",
				dst: instruction.registers[0],
				src: instruction.registers[1],
				operator: instruction.operator,
			};
		case "loadLocal":
		case "storeLocal":
			throw new Error(`Unexpected non-optimized local instruction ${instruction.type}`);
	}

	throw new Error(`Unknown instruction ${(instruction as { type: string }).type}`);
}

function getInstructionFunctionIndex(instruction: {
	type: "loadCaptured" | "storeCaptured";
	functionIndex?: number;
}) {
	if (instruction.functionIndex === undefined) {
		throw new Error(`Missing function index for ${instruction.type}`);
	}

	return instruction.functionIndex;
}
