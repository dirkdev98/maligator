let passed = 0;
function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function caughtValue(fn) {
	try {
		fn();
	} catch (error) {
		return error;
	}
	throw new Error("FAIL expected throw");
}

function iterableFrom(next, close) {
	return {
		[Symbol.iterator]() {
			return { next, return: close };
		},
	};
}

{
	const events = [];
	const target = {};
	Object.defineProperty(target, "value", {
		set(value) {
			events.push("set:" + value.length);
		},
	});
	const key = {
		toString() {
			events.push("coerce");
			return "value";
		},
	};
	const iterable = {
		[Symbol.iterator]() {
			events.push("iterator");
			return {
				next() {
					events.push("next");
					return { done: true };
				},
			};
		},
	};
	function base() {
		events.push("base");
		return target;
	}
	function keyExpression() {
		events.push("key");
		return key;
	}
	[...base()[keyExpression()]] = iterable;
	ok(
		"rest reference order and late key coercion",
		events.join(",") === "iterator,base,key,next,coerce,set:0",
	);
}

{
	const original = { name: "reference" };
	let nextCalls = 0;
	let closeCalls = 0;
	const iterable = iterableFrom(
		function () {
			nextCalls++;
			if (nextCalls > 10) throw new Error("drained before reference");
			return {};
		},
		function () {
			closeCalls++;
			return {};
		},
	);
	function throwingBase() {
		throw original;
	}
	ok(
		"rest throwing reference closes before falsy-done drain",
		caughtValue(function () {
			[...throwingBase().value] = iterable;
		}) === original &&
			nextCalls === 0 &&
			closeCalls === 1,
	);
}

{
	const original = { name: "key" };
	const secondary = { name: "return" };
	let closeCalls = 0;
	const iterable = iterableFrom(
		function () {
			return { done: false, value: 1 };
		},
		function () {
			closeCalls++;
			throw secondary;
		},
	);
	function throwingKey() {
		throw original;
	}
	ok(
		"abrupt close preserves reference error",
		caughtValue(function () {
			[...{}[throwingKey()]] = iterable;
		}) === original && closeCalls === 1,
	);
}

{
	const original = { name: "next" };
	let closeCalls = 0;
	const iterable = iterableFrom(
		function () {
			throw original;
		},
		function () {
			closeCalls++;
			return {};
		},
	);
	const target = {};
	ok(
		"next throw does not close",
		caughtValue(function () {
			[target.value] = iterable;
		}) === original && closeCalls === 0,
	);
}

{
	let getterCalls = 0;
	let setterCalls = 0;
	const target = {};
	Object.defineProperty(target, "value", {
		get() {
			getterCalls++;
		},
		set(value) {
			setterCalls++;
			ok("rest setter receives exhausted values", value.join(",") === "1,2");
		},
	});
	let index = 0;
	const iterable = iterableFrom(function () {
		index++;
		return index <= 2 ? { done: false, value: index } : { done: true };
	});
	[...target.value] = iterable;
	ok("reference capture does not invoke getter", getterCalls === 0 && setterCalls === 1);
}

{
	const setterError = { name: "setter" };
	let closeCalls = 0;
	const target = {};
	Object.defineProperty(target, "value", {
		set() {
			throw setterError;
		},
	});
	const iterable = iterableFrom(
		function () {
			return { done: true };
		},
		function () {
			closeCalls++;
			return {};
		},
	);
	ok(
		"rest setter after exhaustion does not close",
		caughtValue(function () {
			[...target.value] = iterable;
		}) === setterError && closeCalls === 0,
	);
}

{
	const events = [];
	const original = { name: "ordinary-reference" };
	let nextCalls = 0;
	const iterable = iterableFrom(
		function () {
			nextCalls++;
			events.push("next");
			return { done: false, value: 1 };
		},
		function () {
			events.push("return");
			return {};
		},
	);
	function throwingKey() {
		events.push("key");
		throw original;
	}
	ok(
		"ordinary element captures throwing reference before next",
		caughtValue(function () {
			[{}[throwingKey()]] = iterable;
		}) === original &&
			nextCalls === 0 &&
			events.join(",") === "key,return",
	);
}

{
	const setterError = { name: "ordinary-setter" };
	let closeCalls = 0;
	const target = {};
	Object.defineProperty(target, "value", {
		set() {
			throw setterError;
		},
	});
	const iterable = iterableFrom(
		function () {
			return { done: false, value: 1 };
		},
		function () {
			closeCalls++;
			return {};
		},
	);
	ok(
		"ordinary element setter throw closes",
		caughtValue(function () {
			[target.value] = iterable;
		}) === setterError && closeCalls === 1,
	);
}

{
	const setterError = { name: "done-setter" };
	let closeCalls = 0;
	const target = {};
	Object.defineProperty(target, "value", {
		set() {
			throw setterError;
		},
	});
	const iterable = iterableFrom(
		function () {
			return { done: true };
		},
		function () {
			closeCalls++;
			return {};
		},
	);
	ok(
		"done ordinary element setter throw does not close",
		caughtValue(function () {
			[target.value] = iterable;
		}) === setterError && closeCalls === 0,
	);
}

{
	let closeCalls = 0;
	const iterable = iterableFrom(
		function () {
			return { done: false };
		},
		function () {
			closeCalls++;
			return 42;
		},
	);
	ok(
		"normal close validates return object",
		caughtValue(function () {
			[] = iterable;
		}) instanceof TypeError && closeCalls === 1,
	);
}

{
	const returnError = { name: "normal-return" };
	const iterable = iterableFrom(
		function () {
			return { done: false };
		},
		function () {
			throw returnError;
		},
	);
	ok(
		"normal close propagates return throw",
		caughtValue(function () {
			[] = iterable;
		}) === returnError,
	);
}

{
	const events = [];
	function iterable(name, value) {
		return {
			[Symbol.iterator]() {
				return {
					next() {
						return { done: false, value };
					},
					return() {
						events.push(name);
						return {};
					},
				};
			},
		};
	}
	function* nested() {
		const outer = iterable("outer", iterable("inner", undefined));
		const [[value = yield]] = outer;
		return value;
	}
	const iterator = nested();
	iterator.next();
	const result = iterator.return(17);
	ok(
		"generator return closes nested pattern iterators inside out",
		result.done && result.value === 17 && events.join(",") === "inner,outer",
	);
}

{
	const original = { name: "resume-throw" };
	let closeCalls = 0;
	function* suspended() {
		const [value = yield] = iterableFrom(
			function () {
				return { done: false, value: undefined };
			},
			function () {
				closeCalls++;
				throw new Error("secondary");
			},
		);
		return value;
	}
	const iterator = suspended();
	iterator.next();
	ok(
		"generator throw preserves the throw completion while closing once",
		caughtValue(function () {
			iterator.throw(original);
		}) === original && closeCalls === 1,
	);
}

{
	function* suspended(returnMethod) {
		const [value = yield] = iterableFrom(function () {
			return { done: false, value: undefined };
		}, returnMethod);
		return value;
	}
	const missing = suspended(undefined);
	missing.next();
	const missingResult = missing.return(23);
	ok("generator return permits a missing return method", missingResult.value === 23);

	const nonCallable = suspended(1);
	nonCallable.next();
	ok(
		"generator return rejects a non-callable return method",
		caughtValue(function () {
			nonCallable.return(24);
		}) instanceof TypeError,
	);
}

{
	const events = [];
	let receiver;
	class Base {}
	Object.defineProperty(Base.prototype, "value", {
		get() {
			events.push("get");
		},
		set(value) {
			receiver = this;
			events.push("set:" + value.length);
		},
	});
	class Derived extends Base {
		assign(iterable) {
			[
				...super[
					(function () {
						events.push("key");
						return "value";
					})()
				]
			] = iterable;
		}
	}
	const instance = new Derived();
	const iterable = {
		[Symbol.iterator]() {
			events.push("iterator");
			return {
				next() {
					events.push("next");
					return { done: true };
				},
			};
		},
	};
	instance.assign(iterable);
	ok(
		"rest super reference preserves receiver",
		receiver === instance && events.join(",") === "iterator,key,next,set:0",
	);
}

{
	const iteratorPrototype = Object.getPrototypeOf([][Symbol.iterator]());
	let closeCalls = 0;
	Object.defineProperty(iteratorPrototype, "return", {
		configurable: true,
		value() {
			closeCalls++;
			return {};
		},
	});
	function sumPair(pair) {
		const [left, right] = pair;
		return left + right;
	}
	try {
		ok(
			"fixed pair observes Array iterator return mutation",
			sumPair([2, 3]) === 5 && closeCalls === 1,
		);
	} finally {
		delete iteratorPrototype.return;
	}
}

console.log("array-destructuring-close PASS " + passed + "/" + passed);
