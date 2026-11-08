const observations = [];

function discard(regexp, source) {
	regexp.exec(source);
}

function discardLiteral(source) {
	/(a)(b)?/.exec(source);
}

function discardEvaluated(regexp, source) {
	regexp.exec(source());
}

function matched(regexp, source) {
	return regexp.exec(source) !== null;
}

const discardCallback = new Proxy(discard, {});
const literalCallback = new Proxy(discardLiteral, {});

function thrown(callback) {
	try {
		callback();
		return "none";
	} catch (error) {
		return error.name;
	}
}

discardLiteral("prefix-ab-suffix");
observations.push([RegExp.input, RegExp.lastMatch, RegExp.$1, RegExp.$2]);
discard(/missing/, "no match");
observations.push([RegExp.lastMatch, RegExp.$1, RegExp.$2]);

class DerivedRegExp extends RegExp {}
const derived = new DerivedRegExp("a", "g");
Reflect.apply(discardCallback, undefined, [derived, "a"]);
observations.push([derived.lastIndex, derived instanceof DerivedRegExp]);

const altered = /a/g;
Object.defineProperty(altered, "exec", { value: RegExp.prototype.exec });
Object.setPrototypeOf(altered, null);
Reflect.apply(discardCallback, undefined, [altered, "a"]);
observations.push([altered.lastIndex, Object.getPrototypeOf(altered) === null]);

let invalidCoercions = 0;
const invalid = { exec: RegExp.prototype.exec };
observations.push([
	thrown(() =>
		Reflect.apply(discardCallback, undefined, [
			invalid,
			{
				toString() {
					invalidCoercions++;
					return "a";
				},
			},
		]),
	),
	invalidCoercions,
]);

for (const flags of ["g", "y"]) {
	const regexp = new RegExp("a", flags);
	const indices = [];
	for (let index = 0; index < 3; index++) {
		Reflect.apply(discardCallback, undefined, [regexp, "aba"]);
		indices.push(regexp.lastIndex);
	}
	observations.push([flags, indices]);
}

let lastIndexCoercions = 0;
const nonglobal = /a/;
const indexObject = {
	valueOf() {
		lastIndexCoercions++;
		return 2;
	},
};
nonglobal.lastIndex = indexObject;
discard(nonglobal, "a");
observations.push([lastIndexCoercions, nonglobal.lastIndex === indexObject]);

const order = [];
const coerced = /a/g;
coerced.lastIndex = {
	valueOf() {
		order.push("lastIndex");
		return 0;
	},
};
discard(coerced, {
	toString() {
		order.push("input");
		return "a";
	},
});
observations.push([order, coerced.lastIndex]);

let literalCoercions = 0;
discardLiteral({
	toString() {
		literalCoercions++;
		return "ab";
	},
});
observations.push([literalCoercions, RegExp.lastMatch]);
observations.push(
	thrown(() =>
		Reflect.apply(literalCallback, undefined, [
			{
				toString() {
					throw new RangeError();
				},
			},
		]),
	),
);
const throwingIndex = /a/;
throwingIndex.lastIndex = {
	valueOf() {
		throw new SyntaxError();
	},
};
observations.push(
	thrown(() => Reflect.apply(discardCallback, undefined, [throwingIndex, "a"])),
);

for (const source of ["a", "missing"]) {
	const readonly = /a/g;
	Object.defineProperty(readonly, "lastIndex", { writable: false });
	observations.push(
		thrown(() => Reflect.apply(discardCallback, undefined, [readonly, source])),
	);
}

let getterCalls = 0;
let customCalls = 0;
const custom = {
	get exec() {
		getterCalls++;
		return function (source) {
			customCalls++;
			observations.push([this === custom, source]);
			return undefined;
		};
	},
};
discard(custom, "custom input");
observations.push([getterCalls, customCalls]);

const capturedOrder = [];
const captured = /a/;
Object.defineProperty(captured, "exec", {
	configurable: true,
	get() {
		capturedOrder.push("get");
		return RegExp.prototype.exec;
	},
});
discardEvaluated(captured, () => {
	capturedOrder.push("argument");
	Object.defineProperty(captured, "exec", {
		value() {
			capturedOrder.push("replacement");
			return null;
		},
	});
	return "a";
});
observations.push([capturedOrder, RegExp.lastMatch]);
observations.push([matched(/a/, "a"), matched(/a/, "b")]);
const escaped = /(a)/.exec("a");
observations.push([Array.isArray(escaped), escaped[0], escaped[1], escaped.index]);
console.log(JSON.stringify(observations));
