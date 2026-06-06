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
}

export interface IRBlock {
	instructions: Array<IRInstruction>;
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
			type: "call";

			// [destination, callee, ...arguments]
			registers: [number, number, ...Array<number>];
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
				| "!==";
	  };

type IRBinaryOperator = Extract<IRInstruction, { type: "binary" }>["operator"];

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

/**
 * Return 'undefined' from all blocks that don't unconditionally jump yet.
 */
function endFunction(fn: IRFunction) {
	for (const block of fn.blocks) {
		// TODO(opt): once optimized we can probably do with scanning the whole block, since there
		//  might be earlier returns happening.
		const lastInstruction = block.instructions.at(-1);
		if (lastInstruction?.type === "return" || lastInstruction?.type === "jump") {
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
 * Compile an if statement, reading the condition and jumping to the consequent or alternate
 * block.
 */
function compileIfStatement(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	statement: ESTree.IfStatement,
) {
	const condition = compileExpression(program, fn, block, statement.test);
	const consequentBlock = compileStatementsToBlock(
		program,
		fn,
		normalizeStatementOrBlock(statement.consequent),
	);
	block.instructions.push({
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
	block.instructions.push({
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
	const returnRegister = compileExpression(
		program,
		fn,
		block,
		statement.argument ?? { type: "Identifier", name: "undefined" },
	);

	block.instructions.push({
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
	for (const decl of statement.declarations) {
		const source = compileExpression(
			program,
			fn,
			block,

			// Initialize variables to undefined if they don't have an initializer.
			decl.init ?? { type: "Identifier", name: "undefined" },
		);

		const binding = fn.semanticFile.nodeToBinding.get(decl.id);
		if (!binding) {
			continue;
		}

		const location = getOrCreateBindingLocation(program, fn, binding);
		storeRegisterAtLocation(block, location, source);
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
		case "ArrayExpression": {
			return compileArrayExpression(program, fn, block, expression);
		}
		case "AssignmentExpression": {
			return compileAssignment(program, fn, block, expression);
		}
		case "BinaryExpression": {
			return compileBinary(program, fn, block, expression);
		}
		case "CallExpression": {
			return compileCall(program, fn, block, expression);
		}
		case "Identifier": {
			return compileIdentifier(program, fn, block, expression);
		}
		case "Literal": {
			return compileLiteral(program, fn, block, expression);
		}
		case "MemberExpression": {
			return compileMemberExpression(program, fn, block, expression);
		}
		case "ObjectExpression": {
			return compileObjectExpression(program, fn, block, expression);
		}
		default:
			return -1;
	}
}

function compileAssignment(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	assignmentExpression: ESTree.AssignmentExpression,
): number {
	if (assignmentExpression.left.type !== "MemberExpression") {
		return -1;
	}

	const { object, key } = compileMemberObjectAndKey(
		program,
		fn,
		block,
		assignmentExpression.left,
	);

	let value: number;
	if (assignmentExpression.operator === "=") {
		value = compileExpression(program, fn, block, assignmentExpression.right);
	} else {
		const binaryOperator = assignmentOperatorToBinaryOperator(
			assignmentExpression.operator,
		);
		const current = nextRegisterDestination(fn);
		block.instructions.push({
			type: "loadProperty",
			registers: [current, object, key],
		});

		const right = compileExpression(program, fn, block, assignmentExpression.right);
		value = nextRegisterDestination(fn);
		block.instructions.push({
			type: "binary",
			registers: [value, current, right],
			operator: binaryOperator,
		});
	}

	block.instructions.push({
		type: "storeProperty",
		registers: [object, key, value],
	});

	return value;
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
	block: IRBlock,
	binaryExpression: ESTree.BinaryExpression,
): number {
	if (!isIRBinaryOperator(binaryExpression.operator)) {
		throw new Error(`Unsupported binary operator ${binaryExpression.operator}`);
	}

	const left = compileExpression(program, fn, block, binaryExpression.left);
	const right = compileExpression(program, fn, block, binaryExpression.right);

	const destination = nextRegisterDestination(fn);

	block.instructions.push({
		type: "binary",

		registers: [destination, left, right],

		operator: binaryExpression.operator,
	});

	return destination;
}

function compileObjectExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	objectExpression: ESTree.ObjectExpression,
): number {
	const object = nextRegisterDestination(fn);
	block.instructions.push({
		type: "createObject",
		registers: [object],
	});

	for (const property of objectExpression.properties) {
		if (property.type !== "Property" || property.kind !== "init" || property.method) {
			return -1;
		}

		const key = compilePropertyKey(program, fn, block, property);
		const value = compileExpression(
			program,
			fn,
			block,
			property.value as ESTree.Expression,
		);
		block.instructions.push({
			type: "storeProperty",
			registers: [object, key, value],
		});
	}

	return object;
}

function compileArrayExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	arrayExpression: ESTree.ArrayExpression,
): number {
	const array = nextRegisterDestination(fn);
	block.instructions.push({
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

		const key = compileNumberLiteral(fn, block, index);
		const value = compileExpression(program, fn, block, element);
		block.instructions.push({
			type: "storeProperty",
			registers: [array, key, value],
		});
	}

	return array;
}

function compileMemberExpression(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	memberExpression: ESTree.MemberExpression,
): number {
	const { object, key } = compileMemberObjectAndKey(program, fn, block, memberExpression);
	const destination = nextRegisterDestination(fn);
	block.instructions.push({
		type: "loadProperty",
		registers: [destination, object, key],
	});

	return destination;
}

function compileMemberObjectAndKey(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	memberExpression: ESTree.MemberExpression,
) {
	if (memberExpression.object.type === "Super") {
		return { object: -1, key: -1 };
	}

	const object = compileExpression(program, fn, block, memberExpression.object);
	const key = memberExpression.computed
		? compileExpression(program, fn, block, memberExpression.property)
		: memberExpression.property.type === "Identifier"
			? compileStaticString(program, fn, block, memberExpression.property.name)
			: -1;

	return { object, key };
}

function compilePropertyKey(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	property: ESTree.Property,
) {
	if (property.computed) {
		return compileExpression(program, fn, block, property.key);
	}

	if (property.key.type === "Identifier") {
		return compileStaticString(program, fn, block, property.key.name);
	}

	if (property.key.type === "Literal") {
		return compileLiteral(program, fn, block, property.key);
	}

	return -1;
}

function compileStaticString(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	value: string,
) {
	const destination = nextRegisterDestination(fn);
	block.instructions.push({
		type: "createString",
		registers: [destination],
		stringIndex: getOrCreateStringConstant(program, value),
	});

	return destination;
}

function compileCall(
	program: IntermediateProgram,
	fn: IRFunction,
	block: IRBlock,
	callExpression: ESTree.CallExpression,
): number {
	const calleeNode = callExpression.callee as unknown as ESTree.Node;
	if (calleeNode.type === "Super" || (calleeNode.type as string) === "Import") {
		return -1;
	}

	const callee = compileExpression(
		program,
		fn,
		block,
		calleeNode as ESTree.Expression | ESTree.PrivateIdentifier,
	);
	const args = callExpression.arguments.map((arg) => {
		if (arg.type === "SpreadElement") {
			return -1;
		}

		return compileExpression(program, fn, block, arg);
	});
	const destination = nextRegisterDestination(fn);

	block.instructions.push({
		type: "call",
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
	block: IRBlock,
	identifier: ESTree.Identifier,
): number {
	if (identifier.name === "undefined") {
		const destination = nextRegisterDestination(fn);
		block.instructions.push({
			type: "createUndefined",
			registers: [destination],
		});

		return destination;
	}

	const binding = fn.semanticFile.nodeToBinding.get(identifier);
	if (!binding) {
		return -1;
	}

	if (binding.implicit === "arguments") {
		if (fn.argumentsObjectRegister === undefined) {
			throw new Error("Missing reserved arguments object register");
		}

		const destination = nextRegisterDestination(fn);
		block.instructions.push({
			type: "move",
			registers: [destination, fn.argumentsObjectRegister],
		});

		return destination;
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
	block: IRBlock,
	literal: ESTree.Literal,
): number {
	if (typeof literal.value === "number" && Number.isInteger(literal.value)) {
		return compileNumberLiteral(fn, block, literal.value);
	}

	if (typeof literal.value === "string") {
		const destination = nextRegisterDestination(fn);
		block.instructions.push({
			type: "createString",
			registers: [destination],
			stringIndex: getOrCreateStringConstant(program, literal.value),
		});

		return destination;
	}

	return -1;
}

function compileNumberLiteral(fn: IRFunction, block: IRBlock, value: number) {
	const destination = nextRegisterDestination(fn);
	block.instructions.push({
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
