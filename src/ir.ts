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
	bindingToStorage: Map<
		Binding,
		{
			type: "local" | "captured" | "global";
			index: number;
		}
	>;

	/**
	 * Next available global variable index
	 */
	nextGlobalIndex: number;
}

export interface IRFunction {
	semanticFile: SemanticFile;
	blocks: Array<IRBlock>;

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
}

interface IRBlock {
	instructions: Array<IRInstruction>;
}

export type IRInstruction =
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
			type: "jump";

			// [jumpTarget]
			blocks: [number];
	  }
	| {
			type: "loadNumber";

			// [destination]
			registers: [number];

			value: number;
	  }
	| {
			type: "loadUndefined";

			// [destination]
			registers: [number];
	  }
	| {
			type: `load${"Local" | "Captured" | "Global"}`;

			// [destination]
			registers: [number];
			index: number;
	  }
	| {
			// TODO(opt): there is an optimization oppurtunity when a store is 'immediately' followed by
			//  a load.
			type: `store${"Local" | "Captured" | "Global"}`;

			// [source]
			registers: [number];
			index: number;
	  }
	| {
			type: "binary";

			// [destination, left, right]
			registers: [number, number, number];

			operator: "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>" | ">>>";
	  };

function debugIntermediateProgram(program: IntermediateProgram) {
	let output = "";
	const indent = "  ";

	for (const fn of program.functions) {
		output += `FN (params: ${fn.parameterCount})\n`;
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

		compiledModuleInitForPaths: new Set(),
		bindingToStorage: new Map(),

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
		blocks: [],

		parameterCount: 0,
		nextRegisterDestination: 0,
		nextLocalIndex: 0,
		nextCapturedIndex: 0,
	};

	const idx = program.functions.push(fn);
	compileStatementsToBlock(program, fn, initFile.ast.body);

	return idx;
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
	const block: IRBlock = {
		instructions: [],
	};

	const blockIdx = fn.blocks.push(block);

	for (const statement of statements) {
		switch (statement.type) {
			case "ExpressionStatement": {
				compileExpressionStatement(program, fn, block, statement);
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
	compileExpression(program, fn, block, statement.expression);
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
	for (const decl of statement.declarations) {
		const source = compileExpression(
			program,
			fn,
			block,
			decl.init ?? { type: "Identifier", name: "undefined" },
		);

		const binding = fn.semanticFile.nodeToBinding.get(decl.id);
		if (!binding) {
			continue;
		}

		const location = getOrCreateBindingLocation(program, fn, binding);
		switch (location.type) {
			case "local": {
				block.instructions.push({
					type: "storeLocal",
					registers: [source],
					index: location.index,
				});
				break;
			}
			case "global": {
				block.instructions.push({
					type: "storeGlobal",
					registers: [source],
					index: location.index,
				});
				break;
			}
			case "captured": {
				block.instructions.push({
					type: "storeCaptured",
					registers: [source],
					index: location.index,
				});
				break;
			}
		}
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
	block: IRBlock,
	expression: ESTree.Expression | ESTree.PrivateIdentifier,
) {
	switch (expression.type) {
		case "BinaryExpression": {
			return compileBinary(program, fn, block, expression);
		}
		case "Identifier": {
			return compileIdentifier(program, fn, block, expression);
		}
		case "Literal": {
			return compileLiteral(program, fn, block, expression);
		}
		default:
			return -1;
	}
}

function compileBinary(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	binaryExpression: ESTree.BinaryExpression,
): number {
	const left = compileExpression(program, fn, block, binaryExpression.left);
	const right = compileExpression(program, fn, block, binaryExpression.right);

	const destination = nextRegisterDestination(fn);

	block.instructions.push({
		type: "binary",

		registers: [destination, left, right],

		// A tad hacky with types. The ESTree types don't have this strictly typed.
		operator: binaryExpression.operator as "+",
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
	block: IRBlock,
	identifier: ESTree.Identifier,
): number {
	if (identifier.name === "undefined") {
		const destination = nextRegisterDestination(fn);
		block.instructions.push({
			type: "loadUndefined",
			registers: [destination],
		});

		return destination;
	}

	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	if (!binding) {
		return -1;
	}
	const location = getOrCreateBindingLocation(program, fn, binding);

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
				index: location.index,
			});
			break;
		}
	}

	return destination;
}

function compileLiteral(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	literal: ESTree.Literal,
): number {
	if (typeof literal.value === "number" && Number.isInteger(literal.value)) {
		const destination = nextRegisterDestination(fn);
		block.instructions.push({
			type: "loadNumber",
			registers: [destination],

			value: literal.value,
		});

		return destination;
	}

	return -1;
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
