function check(value, message) {
	if (!value) throw new Error(message);
}
function same(left, right) {
	return Object.is(left, right);
}
function reflexive(value) {
	return Object.is(value, value);
}
function numeric(left, right) {
	return Object.is(+left, +right);
}
function integer(left, right) {
	return Object.is(left | 0, right | 0);
}
function boolean(left, right) {
	return Object.is(!!left, !!right);
}
function disjoint(left, right) {
	return Object.is(+left, !!right);
}
function positiveLeft(left, right) {
	return Object.is((left >>> 0) + 1, +right);
}
function positiveRight(left, right) {
	return Object.is(+left, (right >>> 0) + 1);
}
function widePair(left, right) {
	return Object.is((left >>> 0) + 1, (right >>> 0) + 1);
}
function unsignedLeft(left, right) {
	return Object.is(left >>> 0, +right);
}
function unsignedRight(left, right) {
	return Object.is(+left, right >>> 0);
}
function separate(left, right) {
	return Object.is(left & 255, (right >>> 0) + 1024);
}
function* wideSuspended(left, right) {
	const value = (left >>> 0) + 1;
	yield 0;
	return Object.is(value, +right);
}
function missing() {
	return Object.is();
}
function one(value) {
	return Object.is(value);
}
function extra(left, right, effect) {
	return Object.is(left, right, effect());
}
function retained(left, right, effect) {
	const result = Object.is(left, right);
	effect();
	return result;
}
function* suspended(value) {
	return Object.is(value, yield 1);
}
Object.assign(globalThis, {
	same,
	reflexive,
	numeric,
	integer,
	boolean,
	disjoint,
	missing,
	one,
	extra,
	retained,
	suspended,
	positiveLeft,
	positiveRight,
	widePair,
	unsignedLeft,
	unsignedRight,
	separate,
	wideSuspended,
});

const originalObject = Object;
const globalDescriptor = Object.getOwnPropertyDescriptor(globalThis, "Object");
const descriptor = Object.getOwnPropertyDescriptor(Object, "is");
const original = descriptor.value;
const revoked = Proxy.revocable({}, {});
revoked.revoke();
let coercions = 0;
const poison = {
	[Symbol.toPrimitive]() {
		coercions++;
		throw new Error("coerced");
	},
};
const values = [
	NaN,
	0,
	-0,
	Infinity,
	-Infinity,
	0.5,
	1n,
	"same",
	undefined,
	null,
	true,
	Symbol(),
	{},
	revoked.proxy,
	poison,
];
for (const left of values) {
	check(reflexive(left), "reflexive SameValue");
	check(one(left) === original(left, undefined), "omitted right argument");
	for (const right of values) {
		check(same(left, right) === original(left, right), "boxed comparison");
		check(boolean(left, right) === original(!!left, !!right), "Boolean comparison");
		if (typeof left === "number" && typeof right === "number") {
			check(numeric(left, right) === original(+left, +right), "numeric comparison");
			check(integer(left, right) === original(left | 0, right | 0), "integer comparison");
			check(disjoint(left, right) === false, "disjoint argument kinds");
			check(
				positiveLeft(left, right) === original((left >>> 0) + 1, +right),
				"nonzero left range",
			);
			check(
				positiveRight(left, right) === original(+left, (right >>> 0) + 1),
				"nonzero right range",
			);
			check(
				widePair(left, right) === original((left >>> 0) + 1, (right >>> 0) + 1),
				"wide range pair",
			);
			check(
				unsignedLeft(left, right) === original(left >>> 0, +right),
				"positive zero left range",
			);
			check(
				unsignedRight(left, right) === original(+left, right >>> 0),
				"positive zero right range",
			);
			check(separate(left, right) === false, "disjoint ranges");
			const iterator = wideSuspended(left, right);
			check(iterator.next().value === 0, "wide range suspension");
			if (typeof gc === "function") gc();
			check(
				iterator.next().value === original((left >>> 0) + 1, +right),
				"wide range after suspension",
			);
		}
	}
}
check(missing(), "two missing arguments");
check(coercions === 0, "SameValue never coerces");

const marker = {};
let events = [];
try {
	originalObject.defineProperty(originalObject, "is", {
		configurable: true,
		get() {
			events.push("get");
			return original;
		},
	});
	check(
		extra(NaN, NaN, () => {
			events.push("extra");
			originalObject.defineProperty(originalObject, "is", {
				...descriptor,
				value: () => marker,
			});
		}) === true,
		"captured callee survives argument mutation",
	);
	check(events.join() === "get,extra", "lookup precedes extra argument");
	for (const result of [marker, null, 0, 1n, Symbol(), undefined, "changed"]) {
		originalObject.is = function () {
			check(this === originalObject, "replacement receiver");
			return result;
		};
		check(
			same(NaN, NaN) === result && reflexive(NaN) === result && missing() === result,
			"replacement result remains arbitrary",
		);
		for (const invoke of [
			positiveLeft,
			positiveRight,
			widePair,
			unsignedLeft,
			unsignedRight,
			separate,
		])
			check(invoke(1, 1) === result, "range proof retains arbitrary replacement result");
		check(
			retained(marker, marker, () => {
				if (typeof gc === "function") gc();
			}) === result,
			"fallback result survives collection",
		);
	}
	originalObject.is = function () {
		return arguments.length;
	};
	check(
		missing() === 0 && one(1) === 1 && extra(1, 1, () => 0) === 3,
		"fallback argument count",
	);
	originalObject.is = original.bind(null);
	check(same(NaN, NaN) === true, "bound callee fallback");
	originalObject.is = function (left, right) {
		if (typeof gc === "function") gc();
		check(
			left.payload === "left" && right.payload === "right",
			"fallback argument roots",
		);
		return { payload: "fresh" };
	};
	const fresh = retained({ payload: "left" }, { payload: "right" }, () => {
		if (typeof gc === "function") gc();
	});
	check(fresh.payload === "fresh", "fresh fallback result root");
	events = [];
	originalObject.is = new Proxy(original, {
		apply(target, receiver, args) {
			check(receiver === originalObject && args.length === 3, "proxy ABI");
			events.push("apply");
			return Reflect.apply(target, receiver, args);
		},
	});
	check(extra(-0, 0, () => events.push("extra")) === false, "proxy fallback");
	check(events.join() === "extra,apply", "proxy invocation order");
	originalObject.defineProperty(originalObject, "is", descriptor);
	events = [];
	check(
		numeric(
			{
				valueOf() {
					events.push("coerce");
					originalObject.is = () => marker;
					return -0;
				},
			},
			0,
		) === false,
		"callee captured before explicit conversion",
	);
	check(events.join() === "coerce", "explicit conversion occurs once");
	originalObject.defineProperty(originalObject, "is", descriptor);
	const iterator = suspended(NaN);
	check(iterator.next().value === 1, "suspension point");
	originalObject.is = () => marker;
	if (typeof gc === "function") gc();
	check(iterator.next(NaN).value === true, "captured callee survives suspension");
	originalObject.is = () => {
		throw marker;
	};
	let caught;
	try {
		reflexive(1);
	} catch (error) {
		caught = error;
	}
	check(caught === marker, "fallback throw");
	originalObject.is = {};
	caught = undefined;
	try {
		same(1, 1);
	} catch (error) {
		caught = error;
	}
	check(caught instanceof TypeError, "non-callable fallback");
	originalObject.defineProperty(originalObject, "is", {
		configurable: true,
		get() {
			throw marker;
		},
	});
	caught = undefined;
	let extraEffects = 0;
	try {
		extra(1, 1, () => extraEffects++);
	} catch (error) {
		caught = error;
	}
	check(caught === marker && extraEffects === 0, "getter throw precedes arguments");
	originalObject.defineProperty(originalObject, "is", descriptor);
	if (typeof $262 !== "undefined") {
		const foreign = $262.createRealm().global;
		originalObject.is = foreign.Object.is;
		check(same(NaN, NaN) && !same(-0, 0), "foreign SameValue");
	}
} finally {
	originalObject.defineProperty(originalObject, "is", descriptor);
}
try {
	events = [];
	originalObject.defineProperty(globalThis, "Object", {
		configurable: true,
		get() {
			events.push("namespace");
			return originalObject;
		},
	});
	check(
		extra(NaN, NaN, () => events.push("argument")),
		"namespace accessor",
	);
	check(events.join() === "namespace,argument", "namespace accessor precedes arguments");
	const replacement = {
		is(left, right) {
			check(this === replacement, "namespace receiver");
			return marker;
		},
	};
	originalObject.defineProperty(globalThis, "Object", {
		...globalDescriptor,
		value: replacement,
	});
	check(same(1, 1) === marker, "replaced namespace");
} finally {
	originalObject.defineProperty(globalThis, "Object", globalDescriptor);
}
console.log("same value guards passed");
