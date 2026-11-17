function assert(value, name) {
	if (!value) throw new Error(name);
}
function Target(...values) {
	this.values = values;
	this.target = new.target;
}
const events = [];
let selected = Target;
const holder = {
	get C() {
		events.push("callee");
		return selected;
	},
};
const iterable = {
	[Symbol.iterator]() {
		events.push("iterator");
		let index = 0;
		const iterator = {
			next() {
				events.push("next" + index);
				iterator.next = () => {
					throw new Error("uncached next");
				};
				return index++ === 0 ? { value: 4, done: false } : { done: true };
			},
		};
		return iterator;
	},
};
function prefix() {
	events.push("prefix");
	selected = null;
	return { retained: 3 };
}
function tail() {
	events.push("tail");
	return iterable;
}
const result = new holder.C(prefix(), ...tail());
assert(
	result instanceof Target && result.target === Target,
	"selected constructor and new.target",
);
assert(
	result.values[0].retained === 3 && result.values[1] === 4,
	"prefix roots and values",
);
assert(
	events.join() === "callee,prefix,tail,iterator,next0,next1",
	"evaluation order and cached next",
);
console.log("selected callee, order and cached next");

const marker = {};
let iterations = 0;
for (let attempt = 0; attempt < 8; attempt++) {
	try {
		new null(
			...{
				[Symbol.iterator]() {
					iterations++;
					throw marker;
				},
			},
		);
		throw new Error("missing iterator exception");
	} catch (error) {
		assert(error === marker, "iterator error precedes constructor check");
	}
}
assert(
	iterations === 8 && new Target(1, ...[2]).values.join() === "1,2",
	"abrupt stack cleanup",
);
console.log("abrupt completion and stack cleanup");

const bound = Target.bind(null, 1).bind(null, 2);
assert(new bound(3, ...[4]).values.join() === "1,2,3,4", "nested bound arguments");
let expectedNewTarget;
const proxy = new Proxy(Target, {
	construct(target, args, newTarget) {
		assert(newTarget === expectedNewTarget, "bound proxy new.target");
		return Reflect.construct(target, args, newTarget);
	},
});
expectedNewTarget = proxy;
const boundProxy = proxy.bind(null, 5);
const proxied = new boundProxy(6, ...[7]);
assert(
	proxied.values.join() === "5,6,7" && proxied.target === proxy,
	"bound proxy construction",
);
const Other = function () {};
expectedNewTarget = Other;
const alternate = Reflect.construct(boundProxy, [8], Other);
assert(
	alternate.target === Other && Object.getPrototypeOf(alternate) === Other.prototype,
	"bound proxy preserves a distinct new.target",
);
console.log("bound and proxy constructors");

const sparse = [1, , 3];
assert(new Target(...sparse).values.join() === "1,,3", "holes become undefined");
const inherited = Object.create(Array.prototype, {
	1: {
		get() {
			return 8;
		},
	},
});
Object.setPrototypeOf(sparse, inherited);
assert(new Target(...sparse).values.join() === "1,8,3", "inherited indexed getter");
assert(new Target(..."A💡").values.length === 2, "Unicode iteration");
const custom = [1, 2];
custom[Symbol.iterator] = function* () {
	yield 9;
};
assert(new Target(0, ...custom).values.join() === "0,9", "custom iterator");
assert(
	new Target(...[1], 2, ...[3]).values.join() === "1,2,3",
	"multiple spreads fallback",
);
function Override() {
	return { override: true };
}
assert(new Override(...[]).override, "constructor return override");
function builtinArray(tail) {
	return new Array(1, ...tail);
}
assert(builtinArray(custom).join() === "1,9", "builtin iterable argument mode");
console.log("iterable and fallback construction");
