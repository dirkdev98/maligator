const iterator = Array.prototype[Symbol.iterator];
let iteratorCalls = 0;
function replacementIterator() {
	iteratorCalls++;
	let done = false;
	return {
		next() {
			if (done) return { done: true };
			done = true;
			return { done: false, value: "iterator replacement" };
		},
	};
}
const scenario = process.env.PROMISE_ANY_ERRORS_CASE;
let promise;
if (scenario === "empty") {
	promise = Promise.any({
		[Symbol.iterator]() {
			return {
				next() {
					Array.prototype[Symbol.iterator] = replacementIterator;
					return { done: true };
				},
			};
		},
	});
} else if (scenario === "constructor") {
	Array.prototype[Symbol.iterator] = replacementIterator;
	const error = new AggregateError(["first", "second"]);
	Array.prototype[Symbol.iterator] = iterator;
	console.log(JSON.stringify({ errors: error.errors, iteratorCalls }));
} else {
	promise = Promise.any([Promise.reject("first"), Promise.reject("second")]);
	Array.prototype[Symbol.iterator] = replacementIterator;
}
if (promise) {
	let error;
	try {
		await promise;
	} catch (reason) {
		error = reason;
	} finally {
		Array.prototype[Symbol.iterator] = iterator;
	}
	const descriptor = Object.getOwnPropertyDescriptor(error, "errors");
	console.log(
		JSON.stringify({
			name: error.name,
			errors: error.errors,
			iteratorCalls,
			writable: descriptor.writable,
			enumerable: descriptor.enumerable,
			configurable: descriptor.configurable,
		}),
	);
}
