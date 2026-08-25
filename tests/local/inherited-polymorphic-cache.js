class StandardPricing {
	quote(value) {
		return value + 1;
	}
}

class VolumePricing {
	quote(value) {
		return value + 2;
	}
}

class PriorityPricing {
	quote(value) {
		return value + 3;
	}
}

function quote(rule, value) {
	return rule.quote(value);
}

const rules = [new StandardPricing(), new VolumePricing(), new PriorityPricing()];

let actual = 0;
let expected = 0;
for (let index = 0; index < 9000; index++) {
	const family = index % rules.length;
	actual += quote(rules[family], index);
	expected += index + family + 1;
}
if (actual !== expected) throw new Error("alternating prototype methods");

const mixedPrototype = {
	quote(value) {
		return value + 40;
	},
};
const mixedOwn = {
	quote(value) {
		return value + 50;
	},
};
const mixedInherited = Object.create(mixedPrototype);
function mixedQuote(rule, value) {
	return rule.quote(value);
}
for (let index = 0; index < 9000; index++) {
	const rule = index % 2 === 0 ? mixedOwn : mixedInherited;
	const increment = index % 2 === 0 ? 50 : 40;
	if (mixedQuote(rule, index) !== index + increment) {
		throw new Error("alternating own and inherited methods");
	}
}

mixedOwn.quote = function ownReplacement(value) {
	return value + 60;
};
mixedPrototype.quote = function inheritedReplacement(value) {
	return value + 70;
};
if (mixedQuote(mixedOwn, 1) !== 61 || mixedQuote(mixedInherited, 1) !== 71) {
	throw new Error("mixed replacement invalidation");
}

delete mixedOwn.quote;
Object.setPrototypeOf(mixedOwn, mixedPrototype);
if (mixedQuote(mixedOwn, 1) !== 71) {
	throw new Error("own delete reveals inherited method");
}

let mixedGetterCalls = 0;
Object.defineProperty(mixedPrototype, "quote", {
	configurable: true,
	get() {
		mixedGetterCalls++;
		return function mixedAccessor(value) {
			return value + 80;
		};
	},
});
if (
	mixedQuote(mixedOwn, 1) !== 81 ||
	mixedQuote(mixedInherited, 2) !== 82 ||
	mixedGetterCalls !== 2
) {
	throw new Error("mixed accessor invalidation");
}

StandardPricing.prototype.quote = function replacement(value) {
	return value + 10;
};
for (let index = 0; index < 300; index++) {
	const family = index % rules.length;
	const increment = family === 0 ? 10 : family + 1;
	if (quote(rules[family], index) !== index + increment) {
		throw new Error("method replacement invalidation");
	}
}

let getterCalls = 0;
Object.defineProperty(VolumePricing.prototype, "quote", {
	configurable: true,
	get() {
		getterCalls++;
		return function accessorResult(value) {
			return value + 20;
		};
	},
});
for (let index = 0; index < 40; index++) {
	if (quote(rules[1], index) !== index + 20) {
		throw new Error("accessor replacement value");
	}
}
if (getterCalls !== 40) throw new Error("accessor replacement calls");

const inheritedParent = {
	quote(value) {
		return value + 30;
	},
};
delete PriorityPricing.prototype.quote;
Object.setPrototypeOf(PriorityPricing.prototype, inheritedParent);
for (let index = 0; index < 100; index++) {
	if (quote(rules[2], index) !== index + 30) {
		throw new Error("prototype reparenting invalidation");
	}
}

console.log("inherited-polymorphic-cache PASS");
