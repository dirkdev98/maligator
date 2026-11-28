// `new` and `instanceof` read a constructor's own `prototype` on every execution.
// Each scenario warms its sites first, then changes the constructor between reads:
// a writable `prototype` reassigned, a lazily created one, a non-object one, a
// later own @@hasInstance, and constructors that share or leave function shapes.
import url from "node:url";

const log = [];

function record(label, read) {
	try {
		log.push(`${label}: ${String(read())}`);
	} catch (error) {
		log.push(`${label}: ${error.constructor.name}`);
	}
}

function churn() {
	const garbage = [];
	for (let i = 0; i < 300; i++) garbage.push({ i, text: `item-${i}` });
	return garbage.length;
}

function construct(target) {
	return new target();
}

function isInstance(value, target) {
	return value instanceof target;
}

function warm(target, value) {
	let hits = 0;
	for (let i = 0; i < 50; i++) {
		if (construct(target) instanceof target) hits++;
		if (isInstance(value, target)) hits++;
	}
	return hits;
}

function protoName(object, candidates) {
	const prototype = Object.getPrototypeOf(object);
	for (const [name, candidate] of Object.entries(candidates)) {
		if (prototype === candidate) return name;
	}
	return "other";
}

function Reassigned() {}
const firstPrototype = Reassigned.prototype;
const secondPrototype = { second: true };
const thirdPrototype = Object.create(null);
const kept = new Reassigned();
record("reassigned warm", () => warm(Reassigned, kept));
Reassigned.prototype = secondPrototype;
churn();
record("reassigned new reads the new value", () =>
	protoName(construct(Reassigned), { firstPrototype, secondPrototype }),
);
record("reassigned old instance", () => isInstance(kept, Reassigned));
record("reassigned new instance", () => isInstance(construct(Reassigned), Reassigned));
Reassigned.prototype = thirdPrototype;
record("reassigned null-prototype object", () =>
	protoName(construct(Reassigned), { secondPrototype, thirdPrototype }),
);
Reassigned.prototype = 7;
record(
	"non-object prototype falls back",
	() => Object.getPrototypeOf(construct(Reassigned)) === Object.prototype,
);
record("non-object prototype instanceof object", () => isInstance({}, Reassigned));
record("non-object prototype instanceof primitive", () => isInstance(3, Reassigned));
Reassigned.prototype = firstPrototype;
record("restored prototype", () => isInstance(kept, Reassigned));

function Lazy() {}
churn();
record("lazy prototype created by instanceof", () => isInstance({}, Lazy));
record(
	"lazy prototype stable",
	() => Object.getPrototypeOf(construct(Lazy)) === Lazy.prototype,
);
function LazyByNew() {}
record(
	"lazy prototype created by new",
	() => Object.getPrototypeOf(construct(LazyByNew)) === LazyByNew.prototype,
);
record("lazy prototype instance", () => isInstance(construct(LazyByNew), LazyByNew));

// Functions of one shape share a cache entry, so each must read its own slot.
const twins = [];
for (let i = 0; i < 4; i++) twins.push(function Twin() {});
const twinInstances = twins.map((twin) => construct(twin));
record("twins keep their own prototypes", () =>
	twins
		.map((twin, i) =>
			twinInstances.map((instance) => isInstance(instance, twin)).indexOf(true) === i
				? "own"
				: "crossed",
		)
		.join(","),
);
twins[2].prototype = twins[0].prototype;
record("twin sharing another's prototype", () =>
	[isInstance(twinInstances[0], twins[2]), isInstance(twinInstances[2], twins[2])].join(
		",",
	),
);

// More function shapes than entries rotate through them.
const shaped = [];
for (let i = 0; i < 9; i++) {
	const fn = function Shaped() {};
	fn[`static${i}`] = i;
	shaped.push(fn);
}
let shapedHits = 0;
for (let round = 0; round < 20; round++) {
	for (const fn of shaped) {
		const instance = construct(fn);
		if (isInstance(instance, fn) && Object.getPrototypeOf(instance) === fn.prototype) {
			shapedHits++;
		}
		if (round === 10) fn.prototype = { round };
	}
}
record("rotating shapes", () => shapedHits);

function Dictionary() {}
for (let i = 0; i < 40; i++) Dictionary[`key${i}`] = i;
for (let i = 0; i < 40; i += 2) delete Dictionary[`key${i}`];
const dictionaryInstance = new Dictionary();
record("dictionary warm", () => warm(Dictionary, dictionaryInstance));
const dictionaryReplacement = {};
Dictionary.prototype = dictionaryReplacement;
churn();
record("dictionary reassigned", () =>
	[
		Object.getPrototypeOf(construct(Dictionary)) === dictionaryReplacement,
		isInstance(dictionaryInstance, Dictionary),
	].join(","),
);
Object.defineProperty(Dictionary, Symbol.hasInstance, { value: (value) => value === 1 });
record("dictionary later hasInstance", () =>
	[isInstance(1, Dictionary), isInstance(construct(Dictionary), Dictionary)].join(","),
);

function Claims() {}
const claimsInstance = new Claims();
record("claims warm", () => warm(Claims, claimsInstance));
Object.defineProperty(Claims, Symbol.hasInstance, {
	value: (value) => value === "claimed",
	configurable: true,
});
record("later own hasInstance", () =>
	[isInstance("claimed", Claims), isInstance(claimsInstance, Claims)].join(","),
);
delete Claims[Symbol.hasInstance];
record("deleted own hasInstance", () =>
	[isInstance("claimed", Claims), isInstance(claimsInstance, Claims)].join(","),
);

class WithStaticSymbol {
	static [Symbol.iterator]() {}
}
const staticSymbolInstance = new WithStaticSymbol();
record("class with static symbol warm", () =>
	warm(WithStaticSymbol, staticSymbolInstance),
);
Object.defineProperty(WithStaticSymbol, Symbol.hasInstance, { value: () => true });
record("class with static symbol later hasInstance", () =>
	isInstance({}, WithStaticSymbol),
);

function Frozen() {}
const frozenInstance = new Frozen();
record("frozen warm", () => warm(Frozen, frozenInstance));
Object.defineProperty(Frozen, "prototype", { writable: false });
record("non-writable prototype", () =>
	[
		isInstance(frozenInstance, Frozen),
		protoName(construct(Frozen), { p: Frozen.prototype }),
	].join(","),
);
record("non-writable prototype assignment", () => {
	Frozen.prototype = {};
	return "assigned";
});
Object.freeze(Frozen);
record("frozen constructor", () => isInstance(construct(Frozen), Frozen));

class Base {
	constructor() {
		this.base = true;
	}
}
class Derived extends Base {
	constructor() {
		super();
		this.derived = true;
	}
}
const derivedInstance = new Derived();
record("derived warm", () => warm(Derived, derivedInstance));
record("derived instance of base", () => isInstance(derivedInstance, Base));
function Target() {}
const targetFirst = Target.prototype;
record("Reflect.construct newTarget", () =>
	protoName(Reflect.construct(Derived, [], Target), { targetFirst }),
);
const targetSecond = {};
Target.prototype = targetSecond;
record("Reflect.construct newTarget reassigned", () =>
	protoName(Reflect.construct(Derived, [], Target), { targetFirst, targetSecond }),
);
record("Reflect.construct ordinary newTarget", () =>
	protoName(Reflect.construct(Reassigned, [], Target), { targetSecond }),
);
Target.prototype = null;
record(
	"Reflect.construct non-object newTarget prototype",
	() =>
		Object.getPrototypeOf(Reflect.construct(Derived, [], Target)) === Object.prototype,
);
record(
	"Reflect.construct native with newTarget",
	() =>
		Object.getPrototypeOf(Reflect.construct(Map, [], Reassigned)) ===
		Reassigned.prototype,
);

function BoundTarget() {}
const Bound = BoundTarget.bind(null);
const boundInstance = new Bound();
record("bound warm", () => warm(Bound, boundInstance));
const boundReplacement = {};
BoundTarget.prototype = boundReplacement;
record("bound reads the target prototype", () =>
	[
		Object.getPrototypeOf(construct(Bound)) === boundReplacement,
		isInstance(boundInstance, Bound),
	].join(","),
);
let getterReads = 0;
const getterPrototype = {};
Object.defineProperty(Bound, "prototype", {
	get() {
		getterReads++;
		return getterPrototype;
	},
});
record("getter prototype on a newTarget", () =>
	[
		Object.getPrototypeOf(Reflect.construct(Object, [], Bound)) === getterPrototype,
		getterReads,
	].join(","),
);

let trapReads = 0;
const proxyTarget = new Proxy(BoundTarget, {
	get(target, key, receiver) {
		if (key === "prototype") trapReads++;
		return Reflect.get(target, key, receiver);
	},
});
record("proxy newTarget", () =>
	[
		Object.getPrototypeOf(Reflect.construct(Object, [], proxyTarget)) ===
			boundReplacement,
		trapReads,
	].join(","),
);
record("proxy right side", () =>
	[isInstance(construct(BoundTarget), proxyTarget), trapReads].join(","),
);

function Detached() {}
const detachedInstance = new Detached();
record("detached warm", () => warm(Detached, detachedInstance));
Object.setPrototypeOf(Detached, null);
record("null-proto constructor", () =>
	[
		isInstance(detachedInstance, Detached),
		isInstance(construct(Detached), Detached),
	].join(","),
);
Detached.prototype = {};
record("null-proto constructor reassigned", () => isInstance(detachedInstance, Detached));

const promise = Promise.resolve(1);
const map = new Map();
record("native warm", () =>
	[warm(Map, map), isInstance(promise, Promise), isInstance(map, Promise)].join(","),
);
record("native subclass", () => {
	class Mine extends Map {}
	return [isInstance(new Mine(), Map), isInstance(new Mine(), Mine)].join(",");
});
Object.defineProperty(Set, Symbol.hasInstance, { value: (value) => value === map });
record("native later hasInstance", () =>
	[isInstance(map, Set), isInstance(new Set(), Set)].join(","),
);

const Url = url.Url;
const parsed = url.parse("http://example.test/a?b=c");
record("legacy Url warm", () => [warm(Url, parsed), isInstance(parsed, Url)].join(","));
const urlReplacement = { replaced: true };
const urlOriginal = Url.prototype;
Url.prototype = urlReplacement;
churn();
record("legacy Url reassigned", () =>
	[Object.getPrototypeOf(new Url()) === urlReplacement, isInstance(parsed, Url)].join(
		",",
	),
);
Url.prototype = urlOriginal;
record("legacy Url restored", () => isInstance(parsed, Url));

console.log(log.join("\n"));
