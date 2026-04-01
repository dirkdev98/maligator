import type { ESTree } from "meriyah";
import type { SemanticFile, SemanticProgram } from "./semantic-analysis.ts";
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
}

export interface IRFunction {
	parameterCount: number;
	blocks: Array<IRBlock>;

	/**
	 * The next available register index (unoptimized).
	 */
	nextRegisterIndex: number;
}

interface IRBlock {
	instructions: Array<IRInstruction>;
}

export type IRInstruction =
	| {
			type: "return";
			registerValue?: number;
	  }
	| {
			type: "jumpIf";
			conditionRegister: number;
			targetBlockIndex: number;
	  }
	| {
			type: "jump";
			targetBlockIndex: number;
	  }
	| {
			type: "loadNumber";
			registerTarget: number;
			value: number;
	  }
	| {
			type: "loadGlobal";
			globalIndex: number;
			registerTarget: number;
	  }
	| {
			type: "storeGlobal";
			globalIndex: number;
			registerSource: number;
	  }
	| {
			type: "binary";
			registerTarget: number;
			operator: "+" | "-" | "*" | "/" | "%" | "&" | "|" | "^" | "<<" | ">>" | ">>>";

			registerSourceLeft: number;
			registerSourceRight: number;
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
		parameterCount: 0,
		blocks: [],

		nextRegisterIndex: 0,
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
		case "Literal": {
			return compileLiteral(program, fn, block, expression);
		}
		case "BinaryExpression": {
			return compileBinary(program, fn, block, expression);
		}
		default:
			return -1;
	}
}

function compileLiteral(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	literal: ESTree.Literal,
): number {
	if (typeof literal.value === "number" && Number.isInteger(literal.value)) {
		const registerTarget = nextRegisterIndex(fn);
		block.instructions.push({
			type: "loadNumber",
			registerTarget,
			value: literal.value,
		});

		return registerTarget;
	}

	return -1;
}

function compileBinary(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	binaryExpression: ESTree.BinaryExpression,
): number {
	const left = compileExpression(program, fn, block, binaryExpression.left);
	const right = compileExpression(program, fn, block, binaryExpression.right);

	const registerTarget = nextRegisterIndex(fn);
	block.instructions.push({
		type: "binary",

		// A tad hacky with types. The ESTree types don't have this strictly typed.
		operator: binaryExpression.operator as "+",

		registerSourceLeft: left,
		registerSourceRight: right,
		registerTarget,
	});

	return registerTarget;
}

/**
 * We use virtual register per function in this conversion pass.
 *
 * At a later compiler stage these should be optimized to reduce the number of registers needed
 * with things like live-ness checking.
 */
function nextRegisterIndex(fn: IRFunction) {
	return fn.nextRegisterIndex++;
}
