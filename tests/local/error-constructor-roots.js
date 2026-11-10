"use strict";

const events = [];

function collect(label) {
	events.push(label);
	globalThis.__mal_collect_garbage?.();
}

function assert(condition) {
	if (!condition) throw new Error("error construction changed");
}

for (const Constructor of [
	Error,
	TypeError,
	RangeError,
	ReferenceError,
	SyntaxError,
	URIError,
	EvalError,
]) {
	for (const construct of [false, true]) {
		const args = [
			{
				toString() {
					collect(`${Constructor.name}:message`);
					return "collected message";
				},
			},
			{
				get cause() {
					collect(`${Constructor.name}:cause`);
					return { code: 17 };
				},
			},
		];
		const error = construct
			? Reflect.construct(Constructor, args)
			: Reflect.apply(Constructor, undefined, args);
		assert(error.message === "collected message" && error.cause.code === 17);
		assert(error instanceof Constructor);
	}
}

const aggregate = new AggregateError(
	{
		[Symbol.iterator]() {
			collect("aggregate:iterator");
			let index = 0;
			return {
				get next() {
					collect("aggregate:next getter");
					return function () {
						collect("aggregate:next");
						const current = index++;
						return {
							get done() {
								collect("aggregate:done");
								return current === 3;
							},
							get value() {
								collect("aggregate:value");
								return { index: current };
							},
						};
					};
				},
			};
		},
	},
	{
		toString() {
			collect("aggregate:message");
			return "aggregate message";
		},
	},
	{
		get cause() {
			collect("aggregate:cause");
			return { code: 23 };
		},
	},
);
assert(aggregate.message === "aggregate message" && aggregate.cause.code === 23);
assert(aggregate.errors.map((error) => error.index).join(",") === "0,1,2");

const suppressed = new SuppressedError(
	{ code: 31 },
	{ code: 37 },
	{
		toString() {
			collect("suppressed:message");
			return "suppressed message";
		},
	},
);
assert(suppressed.message === "suppressed message");
assert(suppressed.error.code === 31 && suppressed.suppressed.code === 37);

const failure = { code: 41 };
for (const make of [
	() =>
		new Error({
			toString() {
				collect("throw:message");
				throw failure;
			},
		}),
	() =>
		new Error("message", {
			get cause() {
				collect("throw:cause");
				throw failure;
			},
		}),
	() =>
		new SuppressedError(
			{},
			{},
			{
				toString() {
					collect("throw:suppressed");
					throw failure;
				},
			},
		),
	() =>
		new AggregateError({
			[Symbol.iterator]() {
				collect("throw:iterator");
				throw failure;
			},
		}),
	() =>
		new AggregateError({
			[Symbol.iterator]() {
				return {
					next() {
						collect("throw:next");
						throw failure;
					},
				};
			},
		}),
]) {
	let caught;
	try {
		make();
	} catch (error) {
		caught = error;
	}
	assert(caught === failure);
}

console.log(JSON.stringify(events));
