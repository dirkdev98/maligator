import { accessedKey, literalKey } from "./records.ts";
import {
	readsGlobal,
	stableDefinition,
	staticPropertyName,
	stripTypeSyntax,
} from "./syntax.ts";
import type { AnyNode, AstNode, Context } from "./types.ts";

type FunctionNode = AstNode<"FunctionDeclaration" | "FunctionExpression">;
type Member = AstNode<"MemberExpression">;
type Call = AstNode<"CallExpression">;

// Oxlint emits ESLint's code-path events, but its visitor types omit their arguments.
interface Segment {
	prevSegments: Array<Segment>;
}

interface CodePath {
	initialSegment: Segment;
	returnedSegments: Array<Segment>;
}

interface Frame {
	node: AnyNode;
	path: CodePath;
	active: Set<Segment>;
}

interface Write {
	member?: Member;
	segments: Set<Segment>;
}

interface ReceiverWrites {
	path?: CodePath;
	writes: Map<string, Write>;
	calls: Map<string, Set<Segment>>;
	ignoredKeys: Set<string>;
	unknownKeys: boolean;
}

interface Constructor {
	methods: Map<FunctionNode, string>;
	parent?: FunctionNode | null;
	prototypeDescriptors: Set<string>;
}

function thisOwner(node: AnyNode): FunctionNode | undefined {
	for (let parent = node.parent; parent !== null; parent = parent.parent) {
		switch (parent.type) {
			case "FunctionDeclaration":
			case "FunctionExpression":
				return parent;
			case "AccessorProperty":
			case "PropertyDefinition":
			case "StaticBlock":
				return undefined;
		}
	}
	return undefined;
}

function initializer(
	definition: ReturnType<typeof stableDefinition>,
): AnyNode | undefined {
	const node = definition?.node;
	if (
		node?.type !== "VariableDeclarator" ||
		node.id !== definition?.name ||
		node.init === null
	)
		return undefined;
	return stripTypeSyntax(node.init);
}

function localConstructor(context: Context, node: AnyNode): FunctionNode | undefined {
	const definition = stableDefinition(context, stripTypeSyntax(node));
	const value =
		definition?.type === "FunctionName" ? definition.node : initializer(definition);
	if (
		(value?.type === "FunctionDeclaration" || value?.type === "FunctionExpression") &&
		!value.async &&
		!value.generator &&
		value.body !== null
	)
		return value;
	return undefined;
}

function prototypeOwner(
	context: Context,
	node: AnyNode | undefined,
): FunctionNode | undefined {
	const member = node === undefined ? undefined : stripTypeSyntax(node);
	if (member?.type === "MemberExpression" && staticPropertyName(member) === "prototype")
		return localConstructor(context, member.object);
	return undefined;
}

function isUtilModule(node: AnyNode | undefined): boolean {
	return (
		node?.type === "Literal" && (node.value === "util" || node.value === "node:util")
	);
}

function isUtilRequire(context: Context, node: AnyNode | undefined): boolean {
	if (node?.type !== "CallExpression" || !isUtilModule(node.arguments[0])) return false;
	const callee = stripTypeSyntax(node.callee);
	return (
		callee.type === "Identifier" &&
		callee.name === "require" &&
		readsGlobal(context, callee)
	);
}

function isUtilInherits(context: Context, callee: AnyNode): boolean {
	if (callee.type === "MemberExpression" && staticPropertyName(callee) === "inherits") {
		const receiver = stripTypeSyntax(callee.object);
		const definition = stableDefinition(context, receiver);
		const binding = definition?.node;
		return (
			((binding?.type === "ImportNamespaceSpecifier" ||
				binding?.type === "ImportDefaultSpecifier") &&
				binding.parent.type === "ImportDeclaration" &&
				isUtilModule(binding.parent.source)) ||
			isUtilRequire(context, receiver) ||
			isUtilRequire(context, initializer(definition))
		);
	}
	if (callee.type !== "Identifier") return false;
	const definition = stableDefinition(context, callee);
	const binding = definition?.node;
	if (binding?.type === "ImportSpecifier") {
		const { imported, parent } = binding;
		return (
			(imported.type === "Identifier" ? imported.name : imported.value) === "inherits" &&
			parent.type === "ImportDeclaration" &&
			isUtilModule(parent.source)
		);
	}
	if (
		binding?.type !== "VariableDeclarator" ||
		binding.id.type !== "ObjectPattern" ||
		binding.init === null ||
		!isUtilRequire(context, stripTypeSyntax(binding.init))
	)
		return false;
	return binding.id.properties.some(
		(property) =>
			property.type === "Property" &&
			property.value === definition?.name &&
			!property.computed &&
			(property.key.type === "Identifier"
				? property.key.name
				: literalKey(property.key)) === "inherits",
	);
}

function isGlobalObject(context: Context, callee: Member): boolean {
	const object = stripTypeSyntax(callee.object);
	return (
		object.type === "Identifier" &&
		object.name === "Object" &&
		readsGlobal(context, object)
	);
}

function objectKey(property: AstNode<"Property">): string | undefined {
	return !property.computed && property.key.type === "Identifier"
		? property.key.name
		: literalKey(property.key);
}

function prototypeLiteral(
	shape: Constructor,
	literal: AstNode<"ObjectExpression">,
	replaces: boolean,
): void {
	for (const property of literal.properties) {
		if (property.type === "SpreadElement") continue;
		const { computed, kind, value } = property;
		const name = objectKey(property);
		if (
			name === undefined ||
			(name === "__proto__" &&
				!computed &&
				kind === "init" &&
				!property.method &&
				!property.shorthand)
		) {
			if (replaces) shape.parent = null;
			continue;
		}
		if (replaces && kind !== "init") shape.prototypeDescriptors.add(name);
		const method = stripTypeSyntax(value);
		if (
			name !== "constructor" &&
			method.type === "FunctionExpression" &&
			(replaces || kind === "init")
		)
			shape.methods.set(method, name);
	}
}

function isOwnInstanceReturn(context: Context, value: AnyNode): boolean {
	const node = stripTypeSyntax(value);
	return (
		node.type === "ThisExpression" ||
		node.type === "TemplateLiteral" ||
		(node.type === "Literal" && !("regex" in node)) ||
		(node.type === "UnaryExpression" && node.operator === "void") ||
		(node.type === "Identifier" &&
			node.name === "undefined" &&
			readsGlobal(context, node))
	);
}

function initializedOnAllExits(
	path: CodePath | undefined,
	segments: ReadonlySet<Segment>,
): boolean {
	if (path === undefined || segments.size === 0) return false;
	// A successful exit with a write-free path back to entry lacks the key.
	const pending = [...path.returnedSegments];
	const seen = new Set<Segment>();
	while (pending.length > 0) {
		const segment = pending.pop()!;
		if (segments.has(segment) || seen.has(segment)) continue;
		if (segment === path.initialSegment) return false;
		seen.add(segment);
		for (const previous of segment.prevSegments) pending.push(previous);
	}
	return true;
}

function constructorInsertion(
	context: Context,
	body: NonNullable<FunctionNode["body"]>,
	key: string,
) {
	let offset = body.start + 1;
	let next = body.end - 1;
	for (const statement of body.body) {
		if (
			statement.type !== "ExpressionStatement" ||
			typeof statement.directive !== "string"
		) {
			next = statement.start;
			break;
		}
		offset = statement.end;
	}
	let value = "undefined";
	const bodyScope = context.sourceCode.getScope(body);
	for (
		let scope: typeof bodyScope | null = bodyScope;
		scope !== null;
		scope = scope.upper
	) {
		if (scope.set.get("undefined")?.defs.length) {
			value = "void 0";
			break;
		}
	}
	const { text } = context.sourceCode;
	const gap = text.slice(offset, next);
	const newline = /\r\n|\n/u.exec(gap)?.[0];
	const indent = (/[ \t]*$/u.exec(gap)?.[0] ?? "") + (next === body.end - 1 ? "\t" : "");
	const prefix = newline === undefined ? " " : newline + indent;
	// The directive prologue must stay before the inserted assignment.
	const separator =
		offset !== body.start + 1 && newline === undefined && text[offset - 1] !== ";"
			? ";"
			: "";
	const suffix = next === offset ? " " : "";
	return { offset, text: `${separator}${prefix}this.${key} = ${value};${suffix}` };
}

export function functionInstanceVisitors(context: Context) {
	const constructors = new Map<FunctionNode, Constructor>();
	const writesByFunction = new Map<FunctionNode, ReceiverWrites>();
	const unknownReceiver = new Set<FunctionNode>();
	const receiverCalls: Array<{ method: AnyNode; receiver?: AnyNode }> = [];
	const frames: Array<Frame> = [];

	function constructor(fn: FunctionNode): Constructor {
		let shape = constructors.get(fn);
		if (shape === undefined) {
			shape = { methods: new Map(), prototypeDescriptors: new Set() };
			constructors.set(fn, shape);
		}
		return shape;
	}

	function linkParent(fn: FunctionNode, parent: FunctionNode | undefined): void {
		const shape = constructor(fn);
		shape.parent =
			shape.parent === undefined || shape.parent === parent ? (parent ?? null) : null;
	}

	function receiverWrites(fn: FunctionNode): ReceiverWrites {
		let shape = writesByFunction.get(fn);
		if (shape === undefined) {
			shape = {
				writes: new Map(),
				calls: new Map(),
				ignoredKeys: new Set(),
				unknownKeys: false,
			};
			writesByFunction.set(fn, shape);
		}
		return shape;
	}

	function constructorChain(fn: FunctionNode): Set<FunctionNode> | undefined {
		const chain = new Set<FunctionNode>();
		let current: FunctionNode | undefined = fn;
		while (current !== undefined) {
			if (chain.has(current)) return undefined;
			chain.add(current);
			const parent: Constructor["parent"] = constructors.get(current)?.parent;
			if (parent === null) return undefined;
			current = parent;
		}
		return chain;
	}

	function suppressedKeys(fn: FunctionNode): Set<string> | undefined {
		const chain = constructorChain(fn);
		if (chain === undefined) return undefined;
		const keys = new Set<string>();
		for (const current of chain) {
			const own = writesByFunction.get(current);
			if (own?.unknownKeys || unknownReceiver.has(current)) return undefined;
			for (const key of own?.ignoredKeys ?? []) keys.add(key);
			if (current !== fn) for (const key of own?.writes.keys() ?? []) keys.add(key);
			for (const key of constructors.get(current)?.prototypeDescriptors ?? [])
				keys.add(key);
		}
		return keys;
	}

	function instanceOwner(
		node: AnyNode,
		methods: ReadonlyMap<FunctionNode, FunctionNode>,
	): FunctionNode | undefined {
		const expression = stripTypeSyntax(node);
		const value =
			expression.type === "Identifier"
				? initializer(stableDefinition(context, expression))
				: expression;
		if (value?.type === "NewExpression") return localConstructor(context, value.callee);
		if (expression.type !== "ThisExpression") return undefined;
		const fn = thisOwner(expression);
		return fn === undefined
			? undefined
			: (methods.get(fn) ?? (constructors.has(fn) ? fn : undefined));
	}

	function defineProperty(call: Call, fn: FunctionNode | undefined): void {
		const [receiver, property] = call.arguments;
		const key =
			property === undefined ? undefined : literalKey(stripTypeSyntax(property));
		if (fn !== undefined) {
			if (key === undefined) linkParent(fn, undefined);
			else constructor(fn).prototypeDescriptors.add(key);
			return;
		}
		if (receiver === undefined || stripTypeSyntax(receiver).type !== "ThisExpression")
			return;
		const owner = thisOwner(call);
		if (owner === undefined) return;
		const shape = receiverWrites(owner);
		if (key === undefined) shape.unknownKeys = true;
		else shape.ignoredKeys.add(key);
	}

	function assignProperties(call: Call, fn: FunctionNode | undefined): void {
		if (fn !== undefined) {
			for (const argument of call.arguments.slice(1)) {
				const source = stripTypeSyntax(argument);
				if (source.type === "ObjectExpression")
					prototypeLiteral(constructor(fn), source, false);
			}
			return;
		}
		const receiver = call.arguments[0];
		if (receiver === undefined || stripTypeSyntax(receiver).type !== "ThisExpression")
			return;
		const owner = thisOwner(call);
		if (owner === undefined) return;
		const shape = receiverWrites(owner);
		for (const argument of call.arguments.slice(1)) {
			const source = stripTypeSyntax(argument);
			if (source.type !== "ObjectExpression") {
				shape.unknownKeys = true;
				continue;
			}
			for (const property of source.properties) {
				const key = property.type === "Property" ? objectKey(property) : undefined;
				if (key === undefined || key === "__proto__") shape.unknownKeys = true;
				else shape.ignoredKeys.add(key);
			}
		}
	}

	return {
		before() {
			constructors.clear();
			writesByFunction.clear();
			unknownReceiver.clear();
			receiverCalls.length = 0;
			frames.length = 0;
			return context.sourceCode.text.includes("this");
		},
		onCodePathStart(path: unknown, node?: AnyNode) {
			frames.push({ node: node!, path: path as CodePath, active: new Set() });
		},
		onCodePathEnd() {
			const { node, path } = frames.pop()!;
			if (
				(node.type === "FunctionDeclaration" || node.type === "FunctionExpression") &&
				path.returnedSegments.length === 0
			)
				unknownReceiver.add(node);
		},
		onCodePathSegmentStart(segment: unknown) {
			frames.at(-1)!.active.add(segment as Segment);
		},
		onCodePathSegmentEnd(segment: unknown) {
			frames.at(-1)!.active.delete(segment as Segment);
		},
		NewExpression(node: AstNode<"NewExpression">) {
			const fn = localConstructor(context, node.callee);
			if (fn !== undefined) constructor(fn);
		},
		ReturnStatement(node: AstNode<"ReturnStatement">) {
			const frame = frames.at(-1)!;
			const { node: fn, active } = frame;
			if (
				(fn.type === "FunctionDeclaration" || fn.type === "FunctionExpression") &&
				active.size > 0 &&
				node.argument !== null &&
				!isOwnInstanceReturn(context, node.argument)
			)
				unknownReceiver.add(fn);
		},
		"AssignmentExpression:exit"(assignment: AstNode<"AssignmentExpression">) {
			const { left, operator, right } = assignment;
			const target = stripTypeSyntax(left);
			if (operator !== "=" || target.type !== "MemberExpression") return;
			const object = stripTypeSyntax(target.object);
			if (object.type === "ThisExpression") {
				const fn = thisOwner(target);
				const frame = frames.at(-1)!;
				if (fn === undefined || frame.active.size === 0) return;
				const shape = receiverWrites(fn);
				const key = accessedKey(target);
				if (key === undefined || key === "__proto__") {
					if (target.computed || key === "__proto__") shape.unknownKeys = true;
					return;
				}
				if (key === "constructor") return;
				if (fn.body !== null && target.start < fn.body.start) {
					shape.ignoredKeys.add(key);
					return;
				}
				let write = shape.writes.get(key);
				if (write === undefined) {
					write = { segments: new Set() };
					shape.writes.set(key, write);
				}
				if (!target.computed) write.member ??= target;
				if (frame.node === fn) {
					shape.path = frame.path;
					for (const segment of frame.active) write.segments.add(segment);
				}
				return;
			}
			const replacement = prototypeOwner(context, target);
			const value = stripTypeSyntax(right);
			if (replacement !== undefined) {
				const shape = constructor(replacement);
				if (value.type === "ObjectExpression") prototypeLiteral(shape, value, true);
				else shape.parent = null;
				return;
			}
			const key = staticPropertyName(target);
			if (key === undefined) return;
			const fn = prototypeOwner(context, object);
			if (fn === undefined) return;
			if (key === "__proto__") constructor(fn).parent = null;
			else if (key !== "constructor" && value.type === "FunctionExpression")
				constructor(fn).methods.set(value, key);
		},
		"CallExpression:exit"(call: Call) {
			const callee = stripTypeSyntax(call.callee);
			const [first, second] = call.arguments;
			if (callee.type === "MemberExpression") {
				const name = staticPropertyName(callee);
				const frame = frames.at(-1)!;
				const fn = frame.node;
				if (
					(fn.type === "FunctionDeclaration" || fn.type === "FunctionExpression") &&
					name !== undefined &&
					!call.optional &&
					!callee.optional &&
					stripTypeSyntax(callee.object).type === "ThisExpression"
				) {
					const shape = receiverWrites(fn);
					const segments = shape.calls.get(name) ?? new Set<Segment>();
					for (const segment of frame.active) segments.add(segment);
					shape.calls.set(name, segments);
					shape.path = frame.path;
				}
				if (name === "call" || name === "apply" || name === "bind") {
					receiverCalls.push({ method: callee.object, receiver: first });
					return;
				}
				if (prototypeOwner(context, callee.object) !== undefined)
					receiverCalls.push({ method: callee });
				if (
					(name === "assign" || name === "defineProperty" || name === "setPrototypeOf") &&
					isGlobalObject(context, callee)
				) {
					const fn = prototypeOwner(context, first);
					if (name === "defineProperty") defineProperty(call, fn);
					else if (name === "assign") assignProperties(call, fn);
					else if (fn !== undefined) linkParent(fn, prototypeOwner(context, second));
					return;
				}
			}
			if (first === undefined || second === undefined || !isUtilInherits(context, callee))
				return;
			const fn = localConstructor(context, first);
			if (fn !== undefined) linkParent(fn, localConstructor(context, second));
		},
		"Program:exit"() {
			const methodOwners = new Map<FunctionNode, FunctionNode>();
			for (const [fn, shape] of constructors) {
				for (const method of shape.methods.keys()) methodOwners.set(method, fn);
			}
			const borrowed = new Set<FunctionNode>();
			for (const call of receiverCalls) {
				const subject = stripTypeSyntax(call.method);
				const method =
					subject.type === "Identifier"
						? initializer(stableDefinition(context, subject))
						: subject;
				if (method?.type !== "MemberExpression") continue;
				const key = staticPropertyName(method);
				const fn =
					prototypeOwner(context, method.object) ??
					instanceOwner(method.object, methodOwners);
				if (fn === undefined || key === undefined) continue;
				const owner = constructorChain(fn)
					?.values()
					.find((candidate) =>
						constructors
							.get(candidate)
							?.methods.values()
							.some((name) => name === key),
					);
				if (owner === undefined) continue;
				const receiver =
					call.receiver === undefined
						? undefined
						: instanceOwner(call.receiver, methodOwners);
				if (receiver === undefined || !constructorChain(receiver)?.has(owner))
					borrowed.add(owner);
			}
			for (const [fn, shape] of constructors) {
				const body = fn.body;
				if (body === null || borrowed.has(fn)) continue;
				const suppressed = suppressedKeys(fn);
				if (suppressed === undefined) continue;
				const own = writesByFunction.get(fn);
				const candidates = new Map<string, Member>();
				for (const method of [fn, ...shape.methods.keys()]) {
					const writes = writesByFunction.get(method);
					for (const key of writes?.ignoredKeys ?? []) suppressed.add(key);
					for (const [key, { member }] of writes?.writes ?? []) {
						if (member !== undefined && !candidates.has(key)) candidates.set(key, member);
					}
				}
				for (const [key, member] of candidates) {
					if (suppressed.has(key)) continue;
					const segments = new Set(own?.writes.get(key)?.segments);
					for (const [method, name] of shape.methods) {
						const call = own?.calls.get(name);
						const writes = writesByFunction.get(method);
						const write = writes?.writes.get(key);
						if (
							call !== undefined &&
							write !== undefined &&
							initializedOnAllExits(writes?.path, write.segments)
						) {
							for (const segment of call) segments.add(segment);
						}
					}
					if (initializedOnAllExits(own?.path, segments)) continue;
					const insertion = constructorInsertion(context, body, key);
					context.report({
						node: member,
						messageId: "addedOutsideConstructor",
						data: { key },
						suggest: [
							{
								messageId: "initializeInConstructor",
								data: { key },
								fix(fixer) {
									return fixer.insertTextBeforeRange(
										[insertion.offset, insertion.offset],
										insertion.text,
									);
								},
							},
						],
					});
				}
			}
		},
	};
}
