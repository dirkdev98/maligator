import type { ESTree } from "meriyah";
import type { Binding, SemanticFile, SemanticProgram } from "./semantic-analysis.ts";
import { log } from "./utils.ts";

export interface IntermediateProgram {
	/**
	 * The semantic program that we are compiling.
	 */
	semantic: SemanticProgram;

	/**
	 * The functions that we have compiled.
	 *
	 * The first function in this list is the initial entrypoint.
	 */
	functions: Array<IRFunction>;
	stringConstants: Array<Array<number>>;
	stringConstantToIndex: Map<string, number>;

	//////
	// Various caches to prevent duplicate compilation or to look things up.
	//
	// We do things lazily, so only compile things that we has been deemed reachable by static
	// analysis.
	//
	//////

	/**
	 * Compile each module init file only once.
	 */
	compiledModuleInitForPaths: Set<string>;

	/**
	 * Keep track of where the binding is stored.
	 *
	 * A binding can be:
	 *
	 * - local: non-captured variables. We can optimize this out later to keep them in the
	 *   registers, I think.
	 * - captured: captured variables.
	 * - global: top-level declared variables.
	 */
	bindingToStorage: Map<Binding, BindingLocation>;

	/**
	 * Keep track of which functions we compiled already.
	 */
	bindingToFunctionCache: Map<
		Binding,
		{
			fnIndex: number;
		}
	>;
	nodeToFunctionCache: Map<ESTree.Node, { fnIndex: number }>;

	/**
	 * Next available global variable index
	 */
	nextGlobalIndex: number;
}

type BindingLocation =
	| {
			type: "local" | "global";
			index: number;
	  }
	| {
			type: "captured";
			functionIndex: number;
			index: number;
	  };

export interface IRFunction {
	semanticFile: SemanticFile;
	functionIndex: number;

	/**
	 * String constant index of the function name, empty string for anonymous
	 * functions.
	 */
	nameStringIndex: number;

	blocks: Array<IRBlock>;
	argumentsObjectRegister?: number;

	/**
	 * Expected number of initial register values. Before evaluating the arguments and assigning
	 * them to (destructured) arguments.
	 */
	parameterCount: number;

	/**
	 * The next available register index (unoptimized).
	 */
	nextRegisterDestination: number;

	/**
	 * Next available local variable index
	 */
	nextLocalIndex: number;

	/**
	 * Next available captured variable index
	 */
	nextCapturedIndex: number;

	/**
	 * Stack of enclosing loops, used to patch break and continue jumps once
	 * the loop exit and continue targets exist.
	 */
	loops?: Array<IRLoopContext>;
}

interface IRLoopContext {
	/**
	 * break targets the innermost breakable of any kind, continue only loops.
	 */
	kind: "loop" | "switch";
	breakJumps: Array<Extract<IRInstruction, { type: "jump" }>>;
	continueJumps: Array<Extract<IRInstruction, { type: "jump" }>>;
}

export interface IRBlock {
	instructions: Array<IRInstruction>;
}

/**
 * Mutable handle to the block currently being emitted into.
 *
 * Short-circuit expressions create blocks mid-expression and advance the
 * cursor, so instructions following a sub-expression land in the right block.
 */
interface IRCursor {
	block: IRBlock;
}

export type IRInstruction =
	| {
			type: "move";

			// [dest, source]
			registers: [number, number];
	  }
	| {
			type: "return";

			// [return value]
			registers: [number];
	  }
	| {
			type: "jumpIf";

			// [ifTrueRegister]
			registers: [number];

			// [jumpTarget];
			blocks: [number];
	  }
	| {
			// TODO(opt): strip any jump or jumpIf instruction after a previous jump instruction.
			type: "jump";

			// [jumpTarget]
			blocks: [number];
	  }
	| {
			type: "createNumber";

			// [destination]
			registers: [number];

			value: number;
	  }
	| {
			type: "createF64";

			// [destination]
			registers: [number];

			value: number;
	  }
	| {
			type: "createBoolean";

			// [destination]
			registers: [number];

			value: boolean;
	  }
	| {
			type: "createString";

			// [destination]
			registers: [number];

			stringIndex: number;
	  }
	| {
			type: "createObject";

			// [destination]
			registers: [number];
	  }
	| {
			type: "createArray";

			// [destination]
			registers: [number];

			length: number;
	  }
	| {
			type: "createUndefined";

			// [destination]
			registers: [number];
	  }
	| {
			type: "createNull";

			// [destination]
			registers: [number];
	  }
	| {
			type: "createFunction";

			// [destination]
			registers: [number];

			functionIndex: number;
	  }
	| {
			type: "createArgumentsObject";

			// [destination]
			registers: [number];
	  }
	| {
			type: "loadThis";

			// [destination]
			registers: [number];
	  }
	| {
			type: "call";

			// [destination, callee, this, ...arguments]
			registers: [number, number, number, ...Array<number>];
	  }
	| {
			type: "construct";

			// [destination, callee, ...arguments]
			registers: [number, number, ...Array<number>];
	  }
	| {
			type: "throw";

			// [value]
			registers: [number];
	  }
	| {
			type: "catch";

			// [destination]
			registers: [number];
	  }
	| {
			// Marks the start of a protected instruction range. Lowering turns the
			// marker positions into the static exception handler table.
			type: "tryBegin";

			// [handlerBlock, tryEndBlock]
			// The tryEnd block is referenced here so the optimizer cannot drop
			// it when the try body terminates early (return / throw).
			blocks: [number, number];
	  }
	| {
			// Marks the end of a protected instruction range.
			type: "tryEnd";
	  }
	| {
			type: "loadIntrinsic";

			// [destination]
			registers: [number];

			intrinsic: IRIntrinsic;
	  }
	| {
			type: `load${"Local" | "Captured" | "Global"}`;

			// [destination]
			registers: [number];

			functionIndex?: number;
			index: number;
	  }
	| {
			// TODO(opt): there is an optimization opportunity when a store is 'immediately'
			// followed by a load.
			type: `store${"Local" | "Captured" | "Global"}`;

			// [source]
			registers: [number];

			functionIndex?: number;
			index: number;
	  }
	| {
			type: "loadProperty";

			// [destination, object, key]
			registers: [number, number, number];
	  }
	| {
			type: "storeProperty";

			// [object, key, value]
			registers: [number, number, number];
	  }
	| {
			type: "deleteProperty";

			// [destination, object, key]
			registers: [number, number, number];
	  }
	| {
			type: "binary";

			// [destination, left, right]
			registers: [number, number, number];

			operator:
				| "+"
				| "-"
				| "*"
				| "/"
				| "%"
				| "&"
				| "|"
				| "^"
				| "<<"
				| ">>"
				| ">>>"
				| "<"
				| "<="
				| ">"
				| ">="
				| "=="
				| "!="
				| "==="
				| "!=="
				| "in";
	  }
	| {
			type: "unary";

			// [destination, operand]
			registers: [number, number];

			operator: "!" | "-" | "+" | "~" | "typeof";
	  };

type IRBinaryOperator = Extract<IRInstruction, { type: "binary" }>["operator"];
type IRIntrinsic =
	| "Object"
	| "Array"
	| "Function"
	| "Error"
	| "TypeError"
	| "RangeError"
	| "ReferenceError"
	| "SyntaxError"
	| "String"
	| "Number"
	| "Boolean"
	| "parseInt"
	| "parseFloat"
	| "isNaN"
	| "isFinite"
	| "Math"
	| "JSON"
	| "console"
	| "globalThis"
	| "NaN"
	| "Infinity";

const irIntrinsics = new Set<string>([
	"Object",
	"Array",
	"Function",
	"Error",
	"TypeError",
	"RangeError",
	"ReferenceError",
	"SyntaxError",
	"String",
	"Number",
	"Boolean",
	"parseInt",
	"parseFloat",
	"isNaN",
	"isFinite",
	"Math",
	"JSON",
	"console",
	"globalThis",
	"NaN",
	"Infinity",
]);

function isIRIntrinsic(name: string): name is IRIntrinsic {
	return irIntrinsics.has(name);
}

const irBinaryOperators = new Set<string>([
	"+",
	"-",
	"*",
	"/",
	"%",
	"&",
	"|",
	"^",
	"<<",
	">>",
	">>>",
	"<",
	"<=",
	">",
	">=",
	"==",
	"!=",
	"===",
	"!==",
	"in",
]);

function isIRBinaryOperator(operator: string): operator is IRBinaryOperator {
	return irBinaryOperators.has(operator);
}

export function debugIntermediateProgram(program: IntermediateProgram) {
	let output = "";
	const indent = "  ";

	for (const fn of program.functions) {
		output += `FN (params: ${fn.parameterCount}, regCount: ${fn.nextRegisterDestination})\n`;
		for (const block of fn.blocks) {
			output += `${indent}BLOCK\n`;

			for (const instruction of block.instructions) {
				output += `${indent}${indent}${instruction.type} : ${JSON.stringify({ ...instruction, type: undefined })}\n`;
			}
		}
	}

	log.debug(output);
}

/**
 * Tracing compiler from a SemanticProgram to our intermediate representation (IR).
 *
 * Choosing a tracing compiler might bite us in the back later, as we might drop things like
 * functions that are used in dynamic `eval`. But for now it has some advantages:
 *
 * - We can easily skip behavior that we don't support yet.
 * - We do some dead code elimination as well.
 *
 * We might never support dynamic eval tho, so in that case we are all setup ;)
 */
export function compileSemanticProgramToIr(semantic: SemanticProgram) {
	const program: IntermediateProgram = {
		semantic,

		functions: [],
		stringConstants: [],
		stringConstantToIndex: new Map(),

		compiledModuleInitForPaths: new Set(),
		bindingToStorage: new Map(),
		bindingToFunctionCache: new Map(),
		nodeToFunctionCache: new Map(),

		nextGlobalIndex: 0,
	};

	const initFile = program.semantic.files.find(
		(it) => it.path === program.semantic.entrypointPath,
	);

	if (!initFile) {
		throw new Error(`Could not find entrypoint file ${program.semantic.entrypointPath}`);
	}

	compileFileInit(program, initFile);
	debugIntermediateProgram(program);

	return program;
}

/**
 * Compile the top-level statements of a file to initialize all the things.
 */
function compileFileInit(program: IntermediateProgram, initFile: SemanticFile) {
	if (program.compiledModuleInitForPaths.has(initFile.path)) {
		// We already compiled the entrypoint for this file, so we can skip it, so we don't
		// initialize a module twice.
		return -1;
	}
	program.compiledModuleInitForPaths.add(initFile.path);

	const fn: IRFunction = {
		semanticFile: initFile,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(program, ""),
		blocks: [],

		parameterCount: 0,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	// TODO: We trace collect these at the moment, so initialization order is incorrect.
	program.functions.push(fn);

	compileStatementsToBlock(program, fn, initFile.ast.body);
	endFunction(fn);

	return fn.functionIndex;
}

function compileNewFunction(
	program: IntermediateProgram,
	binding: Binding,
	functionNode: ESTree.Node,
) {
	if (
		functionNode.type !== "FunctionDeclaration" &&
		functionNode.type !== "FunctionExpression" &&
		functionNode.type !== "ArrowFunctionExpression"
	) {
		return -1;
	}

	if (program.bindingToFunctionCache.has(binding)) {
		return program.bindingToFunctionCache.get(binding)!.fnIndex;
	}

	// Brute-force find the file. We should do the linkup earlier, so we have / know which file
	// it is.
	let foundFile: SemanticFile | undefined = undefined;
	for (const file of program.semantic.files) {
		if (file.nodeToBinding.get(functionNode)) {
			foundFile = file;
			compileFileInit(program, foundFile);
			break;
		}
	}

	const fn: IRFunction = {
		semanticFile: foundFile ?? program.semantic.files[0]!,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(
			program,
			("id" in functionNode ? functionNode.id?.name : undefined) ?? binding.name,
		),
		blocks: [],

		parameterCount: functionNode.params.length,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	program.functions.push(fn);
	program.bindingToFunctionCache.set(binding, { fnIndex: fn.functionIndex });

	compileFunctionParams(program, fn, functionNode);
	compileStatementsToBlock(
		program,
		fn,
		functionNode.body?.type === "BlockStatement"
			? normalizeStatementOrBlock(functionNode.body)
			: functionNode.body // Handle auto-returning from single-line arrow functions.
				? normalizeStatementOrBlock({
						type: "ReturnStatement",
						argument: functionNode.body,
					})
				: [],
	);

	endFunction(fn);

	return fn.functionIndex;
}

function compileNewFunctionExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	functionNode: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
) {
	const cached = program.nodeToFunctionCache.get(functionNode);
	if (cached) {
		return cached.fnIndex;
	}

	const compiledFn: IRFunction = {
		semanticFile: fn.semanticFile,
		functionIndex: program.functions.length,
		nameStringIndex: getOrCreateStringConstant(
			program,
			functionNode.type === "FunctionExpression" ? (functionNode.id?.name ?? "") : "",
		),
		blocks: [],

		parameterCount: functionNode.params.length,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	program.functions.push(compiledFn);
	program.nodeToFunctionCache.set(functionNode, { fnIndex: compiledFn.functionIndex });

	compileFunctionParams(program, compiledFn, functionNode);
	compileStatementsToBlock(
		program,
		compiledFn,
		functionNode.body?.type === "BlockStatement"
			? normalizeStatementOrBlock(functionNode.body)
			: functionNode.body
				? normalizeStatementOrBlock({
						type: "ReturnStatement",
						argument: functionNode.body,
					})
				: [],
	);
	endFunction(compiledFn);

	return compiledFn.functionIndex;
}

/**
 * Return 'undefined' from all blocks that don't unconditionally jump yet.
 */
function endFunction(fn: IRFunction) {
	for (const block of fn.blocks) {
		// TODO(opt): once optimized we can probably do with scanning the whole block, since there
		//  might be earlier returns happening.
		const lastInstruction = block.instructions.at(-1);
		if (
			lastInstruction?.type === "return" ||
			lastInstruction?.type === "jump" ||
			lastInstruction?.type === "throw"
		) {
			continue;
		}

		const destinationRegister = nextRegisterDestination(fn);
		block.instructions.push(
			{
				type: "createUndefined",
				registers: [destinationRegister],
			},
			{
				type: "return",
				registers: [destinationRegister],
			},
		);
	}
}

function compileFunctionParams(
	program: IntermediateProgram,
	fn: IRFunction,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	const block: IRBlock = {
		instructions: [],
	};
	fn.blocks.push(block);

	for (const param of node.params) {
		// Always allocate a register for the parameter. So we kinda silently skip unsupported
		// params for now.
		const sourceRegister = nextRegisterDestination(fn);

		switch (param.type) {
			case "ArrayPattern":
				break;
			case "AssignmentPattern":
				break;
			case "RestElement":
				break;
			case "ObjectPattern":
				break;
			case "Identifier": {
				const binding = fn.semanticFile.nodeToBinding.get(param);
				if (!binding) {
					throw new Error(`No binding found for parameter ${param.name}`);
				}
				const location = getOrCreateBindingLocation(program, fn, binding);
				storeRegisterAtLocation(block, location, sourceRegister);
				break;
			}
		}
	}

	const argumentsBinding = getArgumentsBinding(fn, node);
	if (argumentsBinding && argumentsBinding.usageNodes.length > 0) {
		const destination = nextRegisterDestination(fn);
		fn.argumentsObjectRegister = destination;
		block.instructions.push({
			type: "createArgumentsObject",
			registers: [destination],
		});
	}

	// Always jump to the next block unconditionally. This will be the function body.
	block.instructions.push({
		type: "jump",
		blocks: [1],
	});
}

/**
 * Compile any list of statements in to an IR block.
 *
 * It adds the block to the function and returns the block index.
 */
function compileStatementsToBlock(
	program: IntermediateProgram,
	fn: IRFunction,
	statements: Array<ESTree.Statement>,
): number {
	let block: IRBlock = {
		instructions: [],
	};
	// Store the first block index so we can return that to allow jumping to that block.
	const blockIdx = fn.blocks.push(block) - 1;

	for (const statement of statements) {
		const lastBlock = fn.blocks.at(-1);
		if (lastBlock !== block) {
			// Any statement may create new blocks. The following logic detects this and starts a new
			// block. It patches up all intermediate blocks to resume control after the statement.
			//
			// For example, with an if-statement:
			//
			// ```
			// BLOCK:
			//   createNumber 1 in reg1
			//   jumpIf reg1 BLOCK2
			// BLOCK2:
			//   call somefn
			//   jump BLOCK3  <-- This is added.
			// BLOCK3:
			//   ...
			// ```
			//
			// Blocks may add other nested blocks that are jumped between. So we may add unnecessary jump
			// instructions to them. We optimize these out later.
			const lastBlockIdx = fn.blocks.indexOf(block);

			block = {
				instructions: [],
			};

			const jumpTarget = fn.blocks.push(block) - 1;
			// Unconditionally add the jump. In a later pass we can optimize these jumps out.
			for (let i = lastBlockIdx + 1; i < jumpTarget; i++) {
				fn.blocks[i]!.instructions.push({
					type: "jump",
					blocks: [jumpTarget],
				});
			}
		}

		switch (statement.type) {
			case "ExpressionStatement": {
				compileExpressionStatement(program, fn, block, statement);
				break;
			}
			case "FunctionDeclaration": {
				compileFunctionDeclaration(program, fn, block, statement);
				break;
			}
			case "IfStatement": {
				compileIfStatement(program, fn, block, statement);
				break;
			}
			case "ReturnStatement": {
				compileReturnStatement(program, fn, block, statement);
				break;
			}
			case "ThrowStatement": {
				compileThrowStatement(program, fn, block, statement);
				break;
			}
			case "TryStatement": {
				compileTryStatement(program, fn, block, statement);
				break;
			}
			case "SwitchStatement": {
				compileSwitchStatement(program, fn, block, statement);
				break;
			}
			case "WhileStatement": {
				compileWhileStatement(program, fn, block, statement);
				break;
			}
			case "DoWhileStatement": {
				compileDoWhileStatement(program, fn, block, statement);
				break;
			}
			case "ForStatement": {
				compileForStatement(program, fn, block, statement);
				break;
			}
			case "BreakStatement": {
				compileBreakStatement(fn, block, statement);
				break;
			}
			case "ContinueStatement": {
				compileContinueStatement(fn, block, statement);
				break;
			}
			case "VariableDeclaration": {
				compileVariableDeclaration(program, fn, block, statement);
				break;
			}
		}
	}

	return blockIdx;
}

function compileExpressionStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ExpressionStatement,
) {
	compileExpression(program, fn, { block }, statement.expression);
}

function compileFunctionDeclaration(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.FunctionDeclaration,
) {
	const binding = fn.semanticFile.nodeToBinding.get(statement);
	if (!binding) {
		return;
	}

	if (
		binding.usageNodes.length === 0 ||
		(binding.usageNodes.length === 1 &&
			(binding.usageNodes[0] === statement || binding.usageNodes[0] === statement.id))
	) {
		// Function is only used in its declaration, so we can skip it.
		return;
	}

	const fnIndex = compileNewFunction(program, binding, statement);
	const location = getOrCreateBindingLocation(program, fn, binding);

	const destination = nextRegisterDestination(fn);
	block.instructions.push({
		type: "createFunction",
		registers: [destination],

		functionIndex: fnIndex,
	});

	storeRegisterAtLocation(block, location, destination);
}

/**
 * Compile a switch statement: the discriminant and case tests stay in the
 * entry block chain, the case bodies are compiled in source order as
 * fall-through blocks, and break jumps are patched to the exit.
 */
function compileSwitchStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.SwitchStatement,
) {
	const switchContext: IRLoopContext = {
		kind: "switch",
		breakJumps: [],
		continueJumps: [],
	};
	(fn.loops ??= []).push(switchContext);

	const cursor: IRCursor = { block };
	const discriminant = compileExpression(program, fn, cursor, statement.discriminant);

	// Case bodies first, chained for fall-through, so the dispatch tests can
	// reference their block indexes.
	const bodyStarts: Array<number> = [];
	let previousTail: IRBlock | undefined;
	for (const switchCase of statement.cases) {
		const start = compileStatementsToBlock(program, fn, switchCase.consequent);
		if (previousTail) {
			previousTail.instructions.push({
				type: "jump",
				blocks: [start],
			});
		}

		bodyStarts.push(start);
		previousTail = fn.blocks.at(-1)!;
	}

	// The last body and the all-misses path both continue at the exit.
	const lastBodyExitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	previousTail?.instructions.push(lastBodyExitJump);

	let defaultCase = -1;
	for (let i = 0; i < statement.cases.length; i++) {
		const switchCase = statement.cases[i]!;
		if (!switchCase.test) {
			defaultCase = i;
			continue;
		}

		const test = compileExpression(program, fn, cursor, switchCase.test);
		const matches = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [matches, discriminant, test],
			operator: "===",
		});
		cursor.block.instructions.push({
			type: "jumpIf",
			registers: [matches],
			blocks: [bodyStarts[i]!],
		});
	}

	const missJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [defaultCase >= 0 ? bodyStarts[defaultCase]! : -1],
	};
	cursor.block.instructions.push(missJump);

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	lastBodyExitJump.blocks[0] = exitIdx;
	if (defaultCase < 0) {
		missJump.blocks[0] = exitIdx;
	}
	for (const jump of switchContext.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	fn.loops.pop();
}

/**
 * Compile a while loop: jump into a header block that evaluates the
 * condition, conditionally enters the body, and falls through to the exit.
 */
function compileWhileStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.WhileStatement,
) {
	const headerIdx = fn.blocks.push({ instructions: [] }) - 1;
	block.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const loop: IRLoopContext = { kind: "loop", breakJumps: [], continueJumps: [] };
	(fn.loops ??= []).push(loop);

	const headerCursor: IRCursor = { block: fn.blocks[headerIdx]! };
	const condition = compileExpression(program, fn, headerCursor, statement.test);

	const bodyIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	headerCursor.block.instructions.push({
		type: "jumpIf",
		registers: [condition],
		blocks: [bodyIdx],
	});
	const exitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		// Patched below, once the exit block exists.
		blocks: [-1],
	};
	headerCursor.block.instructions.push(exitJump);

	// Back edge from the body tail to the condition.
	fn.blocks.at(-1)!.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	exitJump.blocks[0] = exitIdx;
	for (const jump of loop.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	for (const jump of loop.continueJumps) {
		jump.blocks[0] = headerIdx;
	}
	fn.loops.pop();
}

/**
 * Compile a do-while loop: the body runs first, the condition block at the
 * bottom decides on re-entry.
 */
function compileDoWhileStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.DoWhileStatement,
) {
	const loop: IRLoopContext = { kind: "loop", breakJumps: [], continueJumps: [] };
	(fn.loops ??= []).push(loop);

	const bodyIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	block.instructions.push({
		type: "jump",
		blocks: [bodyIdx],
	});

	const bodyLastBlock = fn.blocks.at(-1)!;
	const conditionIdx = fn.blocks.push({ instructions: [] }) - 1;
	bodyLastBlock.instructions.push({
		type: "jump",
		blocks: [conditionIdx],
	});

	const conditionCursor: IRCursor = { block: fn.blocks[conditionIdx]! };
	const condition = compileExpression(program, fn, conditionCursor, statement.test);
	conditionCursor.block.instructions.push({
		type: "jumpIf",
		registers: [condition],
		blocks: [bodyIdx],
	});
	const exitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	conditionCursor.block.instructions.push(exitJump);

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	exitJump.blocks[0] = exitIdx;
	for (const jump of loop.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	for (const jump of loop.continueJumps) {
		jump.blocks[0] = conditionIdx;
	}
	fn.loops.pop();
}

/**
 * Compile a classic for loop: init runs once, then it behaves like a while
 * loop with the update block as the continue target.
 */
function compileForStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ForStatement,
) {
	const initCursor: IRCursor = { block };
	if (statement.init?.type === "VariableDeclaration") {
		compileVariableDeclaration(program, fn, block, statement.init);
		// The declaration manages its own cursor; re-resolve the tail block.
		initCursor.block = fn.blocks.at(-1) === block ? block : fn.blocks.at(-1)!;
	} else if (statement.init) {
		compileExpression(program, fn, initCursor, statement.init);
	}

	const headerIdx = fn.blocks.push({ instructions: [] }) - 1;
	initCursor.block.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const loop: IRLoopContext = { kind: "loop", breakJumps: [], continueJumps: [] };
	(fn.loops ??= []).push(loop);

	const headerCursor: IRCursor = { block: fn.blocks[headerIdx]! };
	let condition: number;
	if (statement.test) {
		condition = compileExpression(program, fn, headerCursor, statement.test);
	} else {
		condition = nextRegisterDestination(fn);
		headerCursor.block.instructions.push({
			type: "createBoolean",
			registers: [condition],
			value: true,
		});
	}

	const bodyIdx = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.body),
	);
	headerCursor.block.instructions.push({
		type: "jumpIf",
		registers: [condition],
		blocks: [bodyIdx],
	});
	const exitJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	headerCursor.block.instructions.push(exitJump);

	// The update block is the continue target and closes the back edge.
	const bodyLastBlock = fn.blocks.at(-1)!;
	const updateIdx = fn.blocks.push({ instructions: [] }) - 1;
	bodyLastBlock.instructions.push({
		type: "jump",
		blocks: [updateIdx],
	});

	const updateCursor: IRCursor = { block: fn.blocks[updateIdx]! };
	if (statement.update) {
		compileExpression(program, fn, updateCursor, statement.update);
	}
	updateCursor.block.instructions.push({
		type: "jump",
		blocks: [headerIdx],
	});

	const exitIdx = fn.blocks.push({ instructions: [] }) - 1;
	exitJump.blocks[0] = exitIdx;
	for (const jump of loop.breakJumps) {
		jump.blocks[0] = exitIdx;
	}
	for (const jump of loop.continueJumps) {
		jump.blocks[0] = updateIdx;
	}
	fn.loops.pop();
}

function compileBreakStatement(
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.BreakStatement,
) {
	const loop = fn.loops?.at(-1);
	if (!loop || statement.label) {
		// TODO(loops): labeled break is not supported yet.
		return;
	}

	const jump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		// Patched by the enclosing loop once the exit block exists.
		blocks: [-1],
	};
	block.instructions.push(jump);
	loop.breakJumps.push(jump);
}

function compileContinueStatement(
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ContinueStatement,
) {
	const loop = fn.loops?.findLast((context) => context.kind === "loop");
	if (!loop || statement.label) {
		// TODO(loops): labeled continue is not supported yet.
		return;
	}

	const jump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	block.instructions.push(jump);
	loop.continueJumps.push(jump);
}

/**
 * Compile a throw statement. The unwinding to the nearest handler happens in
 * the VM based on the statically known handler ranges.
 */
function compileThrowStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ThrowStatement,
) {
	const cursor: IRCursor = { block };
	const value = compileExpression(program, fn, cursor, statement.argument);
	cursor.block.instructions.push({
		type: "throw",
		registers: [value],
	});
}

/**
 * Compile a try statement into a marker-delimited protected range with the
 * handler compiled out-of-line.
 *
 * Invariant: no bare temporary register may be kept live across the tryEnd
 * marker, since the exception edge is invisible to the register allocator.
 * Values that cross the try/catch boundary go through bindings.
 *
 * TODO(finally): the finalizer is duplicated on the normal and caught exits
 *  (and runs + rethrows for catch-less try/finally). It does not run when an
 *  exception propagates out of the catch body itself, and return/break
 *  through the finalizer is not intercepted.
 */
function compileTryStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.TryStatement,
) {
	const finalizerStatements = statement.finalizer
		? normalizeStatementOrBlock(statement.finalizer)
		: [];

	const tryBegin: Extract<IRInstruction, { type: "tryBegin" }> = {
		type: "tryBegin",
		// Patched below, once the handler and exit blocks exist.
		blocks: [-1, -1],
	};
	block.instructions.push(tryBegin);

	const tryBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.block),
	);
	block.instructions.push({
		type: "jump",
		blocks: [tryBlock],
	});

	// The end marker and the normal-exit finalizer copy live directly after
	// the try body, so the protected range ends before them.
	const tryBodyLastBlock = fn.blocks.at(-1)!;
	const tryExitBlock = compileStatementsToBlock(program, fn, finalizerStatements);
	fn.blocks[tryExitBlock]!.instructions.unshift({ type: "tryEnd" });
	tryBegin.blocks[1] = tryExitBlock;
	tryBodyLastBlock.instructions.push({
		type: "jump",
		blocks: [tryExitBlock],
	});

	// The handler block must start with the catch instruction, which consumes
	// the throw completion the unwinder left in place.
	const handlerBlock: IRBlock = {
		instructions: [],
	};
	const handlerBlockIdx = fn.blocks.push(handlerBlock) - 1;
	tryBegin.blocks[0] = handlerBlockIdx;

	const caughtRegister = nextRegisterDestination(fn);
	handlerBlock.instructions.push({
		type: "catch",
		registers: [caughtRegister],
	});

	if (statement.handler) {
		if (statement.handler.param?.type === "Identifier") {
			const binding = fn.semanticFile.nodeToBinding.get(statement.handler.param);
			if (binding) {
				const location = getOrCreateBindingLocation(program, fn, binding);
				storeRegisterAtLocation(handlerBlock, location, caughtRegister);
			}
		}

		const catchBlock = compileStatementsToBlock(program, fn, [
			...normalizeStatementOrBlock(statement.handler.body),
			...finalizerStatements,
		]);
		handlerBlock.instructions.push({
			type: "jump",
			blocks: [catchBlock],
		});
	} else {
		// A catch-less try/finally runs the finalizer and rethrows.
		const finalizerBlock = compileStatementsToBlock(program, fn, finalizerStatements);
		handlerBlock.instructions.push({
			type: "jump",
			blocks: [finalizerBlock],
		});
		fn.blocks.at(-1)!.instructions.push({
			type: "throw",
			registers: [caughtRegister],
		});
	}
}

/**
 * Compile an if statement, reading the condition and jumping to the consequent or alternate
 * block.
 */
function compileIfStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.IfStatement,
) {
	const cursor: IRCursor = { block };
	const condition = compileExpression(program, fn, cursor, statement.test);
	const consequentBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.consequent),
	);
	cursor.block.instructions.push({
		type: "jumpIf",
		registers: [condition],
		blocks: [consequentBlock],
	});

	// We always create an alternate block so we have something to resume.
	const alternate = statement.alternate ?? {
		type: "BlockStatement",
		body: [],
	};
	const alternateBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(alternate),
	);
	cursor.block.instructions.push({
		type: "jump",
		blocks: [alternateBlock],
	});
}

/**
 * Naively compile a return statement.
 */
function compileReturnStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.ReturnStatement,
) {
	const cursor: IRCursor = { block };
	const returnRegister = compileExpression(
		program,
		fn,
		cursor,
		statement.argument ?? { type: "Identifier", name: "undefined" },
	);

	cursor.block.instructions.push({
		type: "return",
		registers: [returnRegister],
	});
}

/**
 * Naively compile variable declarations.
 */
function compileVariableDeclaration(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.VariableDeclaration,
) {
	const cursor: IRCursor = { block };
	for (const decl of statement.declarations) {
		const source = compileExpression(
			program,
			fn,
			cursor,

			// Initialize variables to undefined if they don't have an initializer.
			decl.init ?? { type: "Identifier", name: "undefined" },
		);

		const binding = fn.semanticFile.nodeToBinding.get(decl.id);
		if (!binding) {
			continue;
		}

		const location = getOrCreateBindingLocation(program, fn, binding);
		storeRegisterAtLocation(cursor.block, location, source);
	}
}

/**
 * Expression compilation dispatch.
 *
 * Expressions always return the virtual register index they used.
 */
function compileExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.Expression | ESTree.PrivateIdentifier,
) {
	switch (expression.type) {
		case "ArrayExpression": {
			return compileArrayExpression(program, fn, cursor, expression);
		}
		case "AssignmentExpression": {
			return compileAssignment(program, fn, cursor, expression);
		}
		case "BinaryExpression": {
			return compileBinary(program, fn, cursor, expression);
		}
		case "CallExpression": {
			return compileCall(program, fn, cursor, expression);
		}
		case "NewExpression": {
			return compileNewExpression(program, fn, cursor, expression);
		}
		case "ArrowFunctionExpression":
		case "FunctionExpression": {
			return compileFunctionExpression(program, fn, cursor, expression);
		}
		case "Identifier": {
			return compileIdentifier(program, fn, cursor, expression);
		}
		case "ThisExpression": {
			// TODO(functions): arrow functions should capture the lexical this.
			const destination = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "loadThis",
				registers: [destination],
			});
			return destination;
		}
		case "LogicalExpression": {
			return compileLogicalExpression(program, fn, cursor, expression);
		}
		case "UnaryExpression": {
			return compileUnaryExpression(program, fn, cursor, expression);
		}
		case "UpdateExpression": {
			return compileUpdateExpression(program, fn, cursor, expression);
		}
		case "ConditionalExpression": {
			return compileConditionalExpression(program, fn, cursor, expression);
		}
		case "TemplateLiteral": {
			return compileTemplateLiteral(program, fn, cursor, expression);
		}
		case "Literal": {
			return compileLiteral(program, fn, cursor, expression);
		}
		case "MemberExpression": {
			return compileMemberExpression(program, fn, cursor, expression);
		}
		case "ObjectExpression": {
			return compileObjectExpression(program, fn, cursor, expression);
		}
		default:
			return -1;
	}
}

function compileFunctionExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.FunctionExpression | ESTree.ArrowFunctionExpression,
) {
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createFunction",
		registers: [destination],
		functionIndex: compileNewFunctionExpression(program, fn, expression),
	});

	return destination;
}

function compileAssignment(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	assignmentExpression: ESTree.AssignmentExpression,
): number {
	if (assignmentExpression.left.type === "Identifier") {
		return compileIdentifierAssignment(program, fn, cursor, assignmentExpression);
	}

	if (assignmentExpression.left.type !== "MemberExpression") {
		return -1;
	}

	const { object, key } = compileMemberObjectAndKey(
		program,
		fn,
		cursor,
		assignmentExpression.left,
	);

	let value: number;
	if (assignmentExpression.operator === "=") {
		value = compileExpression(program, fn, cursor, assignmentExpression.right);
	} else {
		const binaryOperator = assignmentOperatorToBinaryOperator(
			assignmentExpression.operator,
		);
		const current = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [current, object, key],
		});

		const right = compileExpression(program, fn, cursor, assignmentExpression.right);
		value = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [value, current, right],
			operator: binaryOperator,
		});
	}

	cursor.block.instructions.push({
		type: "storeProperty",
		registers: [object, key, value],
	});

	return value;
}

function compileIdentifierAssignment(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	assignmentExpression: ESTree.AssignmentExpression,
): number {
	const binding = fn.semanticFile.nodeToBinding.get(assignmentExpression.left);
	if (!binding) {
		return -1;
	}

	const location = getOrCreateBindingLocation(program, fn, binding);

	let value: number;
	if (assignmentExpression.operator === "=") {
		value = compileExpression(program, fn, cursor, assignmentExpression.right);
	} else {
		const binaryOperator = assignmentOperatorToBinaryOperator(
			assignmentExpression.operator,
		);
		const current = loadRegisterFromLocation(fn, cursor.block, location);
		const right = compileExpression(program, fn, cursor, assignmentExpression.right);
		value = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [value, current, right],
			operator: binaryOperator,
		});
	}

	if (value === -1) {
		// The right hand side is not supported yet; skip the store instead of
		// emitting an invalid register reference.
		return -1;
	}

	storeRegisterAtLocation(cursor.block, location, value);
	return value;
}

/**
 * Compile short-circuit logical expressions by branching around the right
 * hand side, with both sides writing the shared result register.
 */
function compileLogicalExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.LogicalExpression,
): number {
	const result = nextRegisterDestination(fn);
	const left = compileExpression(program, fn, cursor, expression.left);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, left],
	});

	// The branch condition: && and || branch on the left value itself, while
	// ?? branches on it being null or undefined.
	let condition = left;
	if (expression.operator === "??") {
		const undefinedRegister = compileUndefined(fn, cursor);
		condition = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [condition, left, undefinedRegister],
			operator: "==",
		});
	}

	const conditionalJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const fallthroughJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(conditionalJump, fallthroughJump);

	const rightIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[rightIdx]!;
	const right = compileExpression(program, fn, cursor, expression.right);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, right],
	});
	const rightJoinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(rightJoinJump);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	if (expression.operator === "||") {
		// A truthy left value skips the right side.
		conditionalJump.blocks[0] = joinIdx;
		fallthroughJump.blocks[0] = rightIdx;
	} else {
		// && enters on a truthy left value, ?? enters on a nil left value.
		conditionalJump.blocks[0] = rightIdx;
		fallthroughJump.blocks[0] = joinIdx;
	}
	rightJoinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

/**
 * Compile ternaries with the same branch-and-join structure as logical
 * expressions.
 */
function compileConditionalExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.ConditionalExpression,
): number {
	const result = nextRegisterDestination(fn);
	const condition = compileExpression(program, fn, cursor, expression.test);

	const consequentJump: Extract<IRInstruction, { type: "jumpIf" }> = {
		type: "jumpIf",
		registers: [condition],
		blocks: [-1],
	};
	const alternateJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(consequentJump, alternateJump);

	const consequentIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[consequentIdx]!;
	const consequent = compileExpression(program, fn, cursor, expression.consequent);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, consequent],
	});
	const consequentJoinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(consequentJoinJump);

	const alternateIdx = fn.blocks.push({ instructions: [] }) - 1;
	cursor.block = fn.blocks[alternateIdx]!;
	const alternate = compileExpression(program, fn, cursor, expression.alternate);
	cursor.block.instructions.push({
		type: "move",
		registers: [result, alternate],
	});
	const alternateJoinJump: Extract<IRInstruction, { type: "jump" }> = {
		type: "jump",
		blocks: [-1],
	};
	cursor.block.instructions.push(alternateJoinJump);

	const joinIdx = fn.blocks.push({ instructions: [] }) - 1;
	consequentJump.blocks[0] = consequentIdx;
	alternateJump.blocks[0] = alternateIdx;
	consequentJoinJump.blocks[0] = joinIdx;
	alternateJoinJump.blocks[0] = joinIdx;
	cursor.block = fn.blocks[joinIdx]!;

	return result;
}

/**
 * Compile untagged template literals as a string concatenation chain. The
 * leading quasi keeps the chain string-typed so + coerces the expressions.
 */
function compileTemplateLiteral(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.TemplateLiteral,
): number {
	let result = compileStaticString(
		program,
		fn,
		cursor,
		expression.quasis[0]?.value.cooked ?? "",
	);

	for (let i = 0; i < expression.expressions.length; i++) {
		const part = compileExpression(
			program,
			fn,
			cursor,
			expression.expressions[i] as ESTree.Expression,
		);
		let next = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [next, result, part],
			operator: "+",
		});
		result = next;

		const quasi = expression.quasis[i + 1]?.value.cooked ?? "";
		if (quasi.length > 0) {
			const quasiRegister = compileStaticString(program, fn, cursor, quasi);
			next = nextRegisterDestination(fn);
			cursor.block.instructions.push({
				type: "binary",
				registers: [next, result, quasiRegister],
				operator: "+",
			});
			result = next;
		}
	}

	return result;
}

function compileUnaryExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.UnaryExpression,
): number {
	if (expression.operator === "void") {
		compileExpression(program, fn, cursor, expression.argument);
		return compileUndefined(fn, cursor);
	}

	if (expression.operator === "delete") {
		return compileDeleteExpression(program, fn, cursor, expression);
	}

	if (
		expression.operator !== "!" &&
		expression.operator !== "-" &&
		expression.operator !== "+" &&
		expression.operator !== "~" &&
		expression.operator !== "typeof"
	) {
		return -1;
	}

	const operand = compileExpression(program, fn, cursor, expression.argument);
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "unary",
		registers: [destination, operand],
		operator: expression.operator,
	});

	return destination;
}

/**
 * Compile delete. Member targets emit the delete instruction; any other
 * operand only gets evaluated and the result is true. Deleting an identifier
 * cannot reach this point: the parser rejects it in (implied) strict mode.
 */
function compileDeleteExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.UnaryExpression,
): number {
	if (expression.argument.type === "MemberExpression") {
		const { object, key } = compileMemberObjectAndKey(
			program,
			fn,
			cursor,
			expression.argument,
		);
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "deleteProperty",
			registers: [destination, object, key],
		});

		return destination;
	}

	compileExpression(program, fn, cursor, expression.argument);

	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createBoolean",
		registers: [destination],
		value: true,
	});

	return destination;
}

/**
 * Compile ++ and -- on identifiers and members. The operand goes through
 * ToNumber (unary plus) so the postfix result is the numeric old value.
 */
function compileUpdateExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.UpdateExpression,
): number {
	const operator = expression.operator === "++" ? "+" : "-";

	if (expression.argument.type === "Identifier") {
		const binding = fn.semanticFile.nodeToBinding.get(expression.argument);
		if (!binding) {
			return -1;
		}

		const location = getOrCreateBindingLocation(program, fn, binding);
		const current = loadRegisterFromLocation(fn, cursor.block, location);
		const oldValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "unary",
			registers: [oldValue, current],
			operator: "+",
		});

		const one = compileNumberLiteral(fn, cursor, 1);
		const newValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [newValue, oldValue, one],
			operator,
		});
		storeRegisterAtLocation(cursor.block, location, newValue);

		return expression.prefix ? newValue : oldValue;
	}

	if (expression.argument.type === "MemberExpression") {
		const { object, key } = compileMemberObjectAndKey(
			program,
			fn,
			cursor,
			expression.argument,
		);
		const current = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [current, object, key],
		});

		const oldValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "unary",
			registers: [oldValue, current],
			operator: "+",
		});

		const one = compileNumberLiteral(fn, cursor, 1);
		const newValue = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "binary",
			registers: [newValue, oldValue, one],
			operator,
		});
		cursor.block.instructions.push({
			type: "storeProperty",
			registers: [object, key, newValue],
		});

		return expression.prefix ? newValue : oldValue;
	}

	return -1;
}

function assignmentOperatorToBinaryOperator(operator: string) {
	if (operator === "=") {
		throw new Error("Simple assignment has no binary operator");
	}

	const binaryOperator = operator.slice(0, -1);
	if (!isIRBinaryOperator(binaryOperator)) {
		throw new Error(`Unsupported assignment operator ${operator}`);
	}

	return binaryOperator;
}

function compileBinary(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	binaryExpression: ESTree.BinaryExpression,
): number {
	if (!isIRBinaryOperator(binaryExpression.operator)) {
		throw new Error(`Unsupported binary operator ${binaryExpression.operator}`);
	}

	const left = compileExpression(program, fn, cursor, binaryExpression.left);
	const right = compileExpression(program, fn, cursor, binaryExpression.right);

	const destination = nextRegisterDestination(fn);

	cursor.block.instructions.push({
		type: "binary",

		registers: [destination, left, right],

		operator: binaryExpression.operator,
	});

	return destination;
}

function compileObjectExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	objectExpression: ESTree.ObjectExpression,
): number {
	const object = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createObject",
		registers: [object],
	});

	for (const property of objectExpression.properties) {
		if (property.type !== "Property" || property.kind !== "init" || property.method) {
			return -1;
		}

		const key = compilePropertyKey(program, fn, cursor, property);
		const value = compileExpression(
			program,
			fn,
			cursor,
			property.value as ESTree.Expression,
		);
		cursor.block.instructions.push({
			type: "storeProperty",
			registers: [object, key, value],
		});
	}

	return object;
}

function compileArrayExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	arrayExpression: ESTree.ArrayExpression,
): number {
	const array = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createArray",
		registers: [array],
		length: arrayExpression.elements.length,
	});

	for (let index = 0; index < arrayExpression.elements.length; index++) {
		const element = arrayExpression.elements[index];
		if (!element) {
			continue;
		}

		if (element.type === "SpreadElement") {
			return -1;
		}

		const key = compileNumberLiteral(fn, cursor, index);
		const value = compileExpression(program, fn, cursor, element);
		cursor.block.instructions.push({
			type: "storeProperty",
			registers: [array, key, value],
		});
	}

	return array;
}

function compileMemberExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	memberExpression: ESTree.MemberExpression,
): number {
	const { object, key } = compileMemberObjectAndKey(
		program,
		fn,
		cursor,
		memberExpression,
	);
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "loadProperty",
		registers: [destination, object, key],
	});

	return destination;
}

function compileMemberObjectAndKey(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	memberExpression: ESTree.MemberExpression,
) {
	if (memberExpression.object.type === "Super") {
		return { object: -1, key: -1 };
	}

	const object = compileExpression(program, fn, cursor, memberExpression.object);
	const key = memberExpression.computed
		? compileExpression(program, fn, cursor, memberExpression.property)
		: memberExpression.property.type === "Identifier"
			? compileStaticString(program, fn, cursor, memberExpression.property.name)
			: -1;

	return { object, key };
}

function compilePropertyKey(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	property: ESTree.Property,
) {
	if (property.computed) {
		return compileExpression(program, fn, cursor, property.key);
	}

	if (property.key.type === "Identifier") {
		return compileStaticString(program, fn, cursor, property.key.name);
	}

	if (property.key.type === "Literal") {
		return compileLiteral(program, fn, cursor, property.key);
	}

	return -1;
}

function compileStaticString(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	value: string,
) {
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createString",
		registers: [destination],
		stringIndex: getOrCreateStringConstant(program, value),
	});

	return destination;
}

function compileCall(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	callExpression: ESTree.CallExpression,
): number {
	const calleeNode = callExpression.callee as unknown as ESTree.Node;
	if (calleeNode.type === "Super" || (calleeNode.type as string) === "Import") {
		return -1;
	}

	let callee: number;
	let thisRegister: number;
	if (calleeNode.type === "MemberExpression") {
		const member = compileMemberObjectAndKey(program, fn, cursor, calleeNode);
		thisRegister = member.object;
		callee = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadProperty",
			registers: [callee, member.object, member.key],
		});
	} else {
		callee = compileExpression(
			program,
			fn,
			cursor,
			calleeNode as ESTree.Expression | ESTree.PrivateIdentifier,
		);
		thisRegister = compileUndefined(fn, cursor);
	}
	const args = callExpression.arguments.map((arg) => {
		if (arg.type === "SpreadElement") {
			return -1;
		}

		return compileExpression(program, fn, cursor, arg);
	});
	const destination = nextRegisterDestination(fn);

	cursor.block.instructions.push({
		type: "call",
		registers: [destination, callee, thisRegister, ...args],
	});

	return destination;
}

/**
 * Compile a new expression. The VM creates the this value from the callee's
 * prototype property and substitutes non-object return values.
 */
function compileNewExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	expression: ESTree.NewExpression,
): number {
	const calleeNode = expression.callee as unknown as ESTree.Node;
	if (calleeNode.type === "Super" || (calleeNode.type as string) === "Import") {
		return -1;
	}

	const callee = compileExpression(program, fn, cursor, calleeNode as ESTree.Expression);
	const args = expression.arguments.map((arg) => {
		if (arg.type === "SpreadElement") {
			return -1;
		}

		return compileExpression(program, fn, cursor, arg);
	});
	const destination = nextRegisterDestination(fn);

	cursor.block.instructions.push({
		type: "construct",
		registers: [destination, callee, ...args],
	});

	return destination;
}

/**
 * Compile identifiers to load instructions.
 *
 * Statements that store the a variable internally handle the store instructions.
 */
function compileIdentifier(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	identifier: ESTree.Identifier,
): number {
	if (identifier.name === "undefined") {
		return compileUndefined(fn, cursor);
	}

	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	if (!binding) {
		return -1;
	}

	if (binding.undeclared && isIRIntrinsic(identifier.name)) {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "loadIntrinsic",
			registers: [destination],
			intrinsic: identifier.name,
		});
		return destination;
	}

	if (binding.implicit === "arguments") {
		if (fn.argumentsObjectRegister === undefined) {
			throw new Error("Missing reserved arguments object register");
		}

		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "move",
			registers: [destination, fn.argumentsObjectRegister],
		});

		return destination;
	}

	const location = getOrCreateBindingLocation(program, fn, binding);
	return loadRegisterFromLocation(fn, cursor.block, location);
}

function loadRegisterFromLocation(
	fn: IRFunction,
	block: IRBlock,
	location: BindingLocation,
) {
	const destination = nextRegisterDestination(fn);
	switch (location.type) {
		case "local": {
			block.instructions.push({
				type: "loadLocal",
				registers: [destination],
				index: location.index,
			});
			break;
		}
		case "global": {
			block.instructions.push({
				type: "loadGlobal",
				registers: [destination],
				index: location.index,
			});
			break;
		}
		case "captured": {
			block.instructions.push({
				type: "loadCaptured",
				registers: [destination],

				functionIndex: location.functionIndex,
				index: location.index,
			});
			break;
		}
	}

	return destination;
}

function getArgumentsBinding(
	fn: IRFunction,
	node:
		| ESTree.FunctionDeclaration
		| ESTree.FunctionExpression
		| ESTree.ArrowFunctionExpression,
) {
	if (node.type === "ArrowFunctionExpression") {
		return undefined;
	}

	const scope = fn.semanticFile.nodeToScope.get(node);
	return scope?.bindings.find((binding) => binding.implicit === "arguments");
}

function compileLiteral(
	program: IntermediateProgram,
	fn: IRFunction,
	cursor: IRCursor,
	literal: ESTree.Literal,
): number {
	if (
		typeof literal.value === "number" &&
		Number.isInteger(literal.value) &&
		literal.value >= -2147483648 &&
		literal.value <= 2147483647
	) {
		return compileNumberLiteral(fn, cursor, literal.value);
	}

	if (typeof literal.value === "number" && Number.isFinite(literal.value)) {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createF64",
			registers: [destination],
			value: literal.value,
		});

		return destination;
	}

	if (typeof literal.value === "boolean") {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createBoolean",
			registers: [destination],
			value: literal.value,
		});

		return destination;
	}

	if (typeof literal.value === "string") {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createString",
			registers: [destination],
			stringIndex: getOrCreateStringConstant(program, literal.value),
		});

		return destination;
	}

	if (literal.value === null) {
		const destination = nextRegisterDestination(fn);
		cursor.block.instructions.push({
			type: "createNull",
			registers: [destination],
		});

		return destination;
	}

	return -1;
}

function compileUndefined(fn: IRFunction, cursor: IRCursor) {
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createUndefined",
		registers: [destination],
	});

	return destination;
}

function compileNumberLiteral(fn: IRFunction, cursor: IRCursor, value: number) {
	const destination = nextRegisterDestination(fn);
	cursor.block.instructions.push({
		type: "createNumber",
		registers: [destination],

		value,
	});

	return destination;
}

function getOrCreateStringConstant(program: IntermediateProgram, value: string) {
	const existing = program.stringConstantToIndex.get(value);
	if (existing !== undefined) {
		return existing;
	}

	const codeUnits = [];
	for (let i = 0; i < value.length; i++) {
		codeUnits.push(value.charCodeAt(i));
	}

	const index = program.stringConstants.push(codeUnits) - 1;
	program.stringConstantToIndex.set(value, index);
	return index;
}

/**
 * We use virtual register per function in this conversion pass.
 *
 * At a later compiler stage these should be optimized to reduce the number of registers needed
 * with things like live-ness checking.
 */
function nextRegisterDestination(fn: IRFunction) {
	return fn.nextRegisterDestination++;
}

/**
 * Get or create a binding location.
 * We use incremental indices to assign unique locations to bindings. Memoizing the location
 * per binding.
 */
function getOrCreateBindingLocation(
	program: IntermediateProgram,
	fn: IRFunction,
	binding: Binding,
) {
	let location = program.bindingToStorage.get(binding);
	if (!location) {
		switch (binding.scopedTo) {
			case "local": {
				location = {
					type: "local",
					index: fn.nextLocalIndex++,
				};
				break;
			}
			case "captured": {
				location = {
					type: "captured",
					functionIndex: fn.functionIndex,
					index: fn.nextCapturedIndex++,
				};
				break;
			}
			case "global": {
				location = {
					type: "global",
					index: program.nextGlobalIndex++,
				};
				break;
			}
			default:
				throw new Error(
					`Unknown binding scope: ${binding.scopedTo} ${binding.name} ${binding.kind}`,
				);
		}

		program.bindingToStorage.set(binding, location);
	}

	return location;
}

/**
 * Store register at a binding location.
 */
function storeRegisterAtLocation(
	block: IRBlock,
	location: BindingLocation,
	register: number,
) {
	switch (location.type) {
		case "local": {
			block.instructions.push({
				type: "storeLocal",
				registers: [register],
				index: location.index,
			});
			break;
		}
		case "global": {
			block.instructions.push({
				type: "storeGlobal",
				registers: [register],
				index: location.index,
			});
			break;
		}
		case "captured": {
			block.instructions.push({
				type: "storeCaptured",
				registers: [register],

				functionIndex: location.functionIndex,
				index: location.index,
			});
			break;
		}
	}
}

/**
 * Things like if-statements don't need a full block body so might be bare statements.
 * We convert them to an array so we can keep if simple signature when compiling blocks.
 */
function normalizeStatementOrBlock(statement: ESTree.Statement) {
	if (statement.type === "BlockStatement") {
		return statement.body;
	}

	return [statement];
}
