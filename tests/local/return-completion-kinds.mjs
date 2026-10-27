function check(actual, expected, label) {
	if (!Object.is(actual, expected)) throw new Error(label);
}
const collect = () => globalThis.gc?.();
const marker = { payload: "rooted".repeat(100) };
function objectResult(value) {
	const result = { value };
	collect();
	return result;
}
function primitiveUnion(flag) {
	return flag ? "text" : 7;
}
function primitiveNullable(flag) {
	return flag ? null : 12345678901234567890n;
}
function primitiveOptional(flag) {
	return flag ? undefined : true;
}
function symbolResult(value) {
	if (typeof value !== "symbol") throw marker;
	collect();
	return value;
}
function unknownResult(value) {
	collect();
	return value;
}
function arrowResult() {
	return () => new.target;
}
for (const construct of [false, true]) {
	const object = construct ? new objectResult(marker) : objectResult(marker);
	collect();
	check(object.value, marker, "returned Object identity");
	check(
		Object.getPrototypeOf(object),
		Object.prototype,
		"Object overrides constructor receiver",
	);
	for (const flag of [false, true]) {
		const result = construct ? new primitiveUnion(flag) : primitiveUnion(flag);
		if (construct)
			check(
				Object.getPrototypeOf(result),
				primitiveUnion.prototype,
				"primitive construction receiver",
			);
		else check(result, flag ? "text" : 7, "ordinary primitive return");
		check(
			primitiveNullable(flag),
			flag ? null : 12345678901234567890n,
			"nullable primitive return",
		);
		check(
			Object.getPrototypeOf(new primitiveNullable(flag)),
			primitiveNullable.prototype,
			"nullable construction receiver",
		);
		check(primitiveOptional(flag), flag ? undefined : true, "optional primitive return");
		check(
			Object.getPrototypeOf(new primitiveOptional(flag)),
			primitiveOptional.prototype,
			"optional construction receiver",
		);
	}
	const arrow = construct ? new arrowResult() : arrowResult();
	collect();
	check(
		arrow(),
		construct ? arrowResult : undefined,
		"lexical new.target survives Object return",
	);
}
const returnedSymbol = Symbol("bounded");
check(
	symbolResult(returnedSymbol),
	returnedSymbol,
	"Symbol return through boxed storage",
);
check(
	Object.getPrototypeOf(new symbolResult(returnedSymbol)),
	symbolResult.prototype,
	"Symbol construction receiver",
);
try {
	new symbolResult(marker);
	throw new Error("missing Symbol guard throw");
} catch (error) {
	check(error, marker, "Symbol guard exception");
}
for (const value of [
	undefined,
	null,
	true,
	9,
	"text",
	12345678901234567890n,
	Symbol("return"),
	marker,
	() => marker,
]) {
	check(unknownResult(value), value, "unknown ordinary completion");
	const result = new unknownResult(value);
	if ((typeof value === "object" && value !== null) || typeof value === "function")
		check(result, value, "unknown Object completion");
	else
		check(
			Object.getPrototypeOf(result),
			unknownResult.prototype,
			"unknown primitive construction",
		);
}
let coercions = 0;
function coerciveResult(value) {
	return +value;
}
const numeric = {
	valueOf() {
		coercions++;
		collect();
		return 17;
	},
};
check(coerciveResult(numeric), 17, "ordinary coercion");
check(
	Object.getPrototypeOf(new coerciveResult(numeric)),
	coerciveResult.prototype,
	"constructor coercion",
);
check(coercions, 2, "ignored primitive still evaluates");
try {
	new coerciveResult({
		valueOf() {
			collect();
			throw marker;
		},
	});
	throw new Error("missing coercion throw");
} catch (error) {
	check(error, marker, "coercion exception identity");
}
let baseCalls = 0;
class Parent {
	constructor() {
		baseCalls++;
		this.bound = true;
		collect();
	}
}
class ObjectBeforeSuper extends Parent {
	constructor(value) {
		const result = { value };
		collect();
		return result;
	}
}
class FunctionBeforeSuper extends Parent {
	constructor() {
		return () => marker;
	}
}
class PrimitiveAfterSuper extends Parent {
	constructor() {
		super();
		return 7;
	}
}
class UndefinedAfterSuper extends Parent {
	constructor() {
		super();
		return undefined;
	}
}
class UnknownBeforeSuper extends Parent {
	constructor(value) {
		collect();
		return value;
	}
}
check(new ObjectBeforeSuper(marker).value, marker, "Object before super");
check(new FunctionBeforeSuper()(), marker, "Function before super");
check(baseCalls, 0, "Object completions skip super");
check(new UndefinedAfterSuper().bound, true, "derived undefined completion");
check(baseCalls, 1, "super runs once");
try {
	new PrimitiveAfterSuper();
	throw new Error("missing derived TypeError");
} catch (error) {
	check(error instanceof TypeError, true, "derived primitive throws");
}
check(baseCalls, 2, "super effects precede primitive throw");
check(new UnknownBeforeSuper(marker), marker, "unknown Object before super");
try {
	ObjectBeforeSuper(marker);
	throw new Error("missing class call error");
} catch (error) {
	check(error instanceof TypeError, true, "class invocation still requires new");
}
function Alternate() {}
check(
	Object.getPrototypeOf(Reflect.construct(primitiveUnion, [false], Alternate)),
	Alternate.prototype,
	"alternate construction receiver",
);
check(
	Reflect.construct(objectResult, [marker], Alternate).value,
	marker,
	"alternate Object completion",
);
for (const value of [undefined, null, true, 7, "text", 9n, Symbol("derived")]) {
	try {
		new UnknownBeforeSuper(value);
		throw new Error("missing derived completion error");
	} catch (error) {
		check(
			value === undefined ? error instanceof ReferenceError : error instanceof TypeError,
			true,
			"derived error kind",
		);
	}
}
function* resumedObject(value) {
	yield 1;
	collect();
	return { value };
}
const generator = resumedObject(marker);
check(generator.next().value, 1, "generator yield");
check(generator.next().value.value, marker, "generator Object completion");
async function awaitedObject(value) {
	await 0;
	collect();
	return { value };
}
check((await awaitedObject(marker)).value, marker, "async Object completion");
console.log("return-completion-kinds PASS");
