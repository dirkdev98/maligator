// InstanceofOperator over right sides whose own [[Prototype]] is not
// %Function.prototype%, and the shapes next to them: @@hasInstance lookup walks the
// right side's chain, OrdinaryHasInstance reads `prototype` and walks the left side's.
const log = [];

function record(label, read) {
	try {
		log.push(`${label}: ${String(read())}`);
	} catch (error) {
		log.push(`${label}: ${error.constructor.name}`);
	}
}

function isInstance(value, target) {
	return value instanceof target;
}

function churn() {
	const garbage = [];
	for (let i = 0; i < 200; i++) garbage.push({ i, s: `item-${i}` });
	return garbage.length;
}

// Each shape runs at an inline site and through one shared helper, so both the
// operator's generic entry and a helper that has seen many right sides observe it.
function check(label, value, target) {
	record(`${label} inline`, () => value instanceof target);
	record(`${label} helper`, () => isInstance(value, target));
}

function Detached() {}
Object.setPrototypeOf(Detached, null);
check("null-proto function, plain object", {}, Detached);
check("null-proto function, primitive", 1, Detached);
const detachedInstance = new Detached();
check("null-proto function, own instance", detachedInstance, Detached);
check(
	"null-proto function, object prototype instance",
	Object.create(Detached.prototype),
	Detached,
);
record(
	"null-proto function hasInstance method",
	() => typeof Detached[Symbol.hasInstance],
);
record("Function.prototype[@@hasInstance] on null-proto function", () =>
	Function.prototype[Symbol.hasInstance].call(Detached, detachedInstance),
);

function DetachedBeforeRead() {}
Object.setPrototypeOf(DetachedBeforeRead, null);
churn();
check("null-proto function, prototype created by the check", {}, DetachedBeforeRead);
record(
	"lazily created prototype is stable",
	() => Object.getPrototypeOf(new DetachedBeforeRead()) === DetachedBeforeRead.prototype,
);

const detachedArrow = () => {};
Object.setPrototypeOf(detachedArrow, null);
check("null-proto arrow, object", {}, detachedArrow);
check("null-proto arrow, primitive", 1, detachedArrow);

let resolveNative;
new Promise((resolve) => {
	resolveNative = resolve;
});
Object.setPrototypeOf(resolveNative, null);
check("null-proto native function without prototype", {}, resolveNative);

class Isolated {}
const isolatedInstance = new Isolated();
Object.setPrototypeOf(Isolated, null);
check("null-proto class, instance", isolatedInstance, Isolated);
check("null-proto class, plain object", {}, Isolated);
check("null-proto class, new instance", new Isolated(), Isolated);

class Base {}
class Derived extends Base {}
const derivedInstance = new Derived();
Object.setPrototypeOf(Derived, null);
check("null-proto derived class, instance", derivedInstance, Derived);
check("null-proto derived class, base instance", new Base(), Derived);
record("null-proto derived class, construct", () => new Derived());

const bind = (target) => Function.prototype.bind.call(target, null);
const detachedBound = bind(Detached);
record("bound over null-proto target inherits null", () =>
	Object.getPrototypeOf(detachedBound),
);
check("bound over null-proto target, target instance", detachedInstance, detachedBound);
check("bound over null-proto target, plain object", {}, detachedBound);
check("bound over null-proto target, bound instance", new detachedBound(), detachedBound);
const doublyBound = bind(detachedBound);
check("bound twice over null-proto target", detachedInstance, doublyBound);

function Plain() {}
const plainBound = bind(Plain);
Object.setPrototypeOf(plainBound, null);
check("null-proto bound function, target instance", new Plain(), plainBound);
check("null-proto bound function, plain object", {}, plainBound);

function Claims() {}
Object.defineProperty(Claims, Symbol.hasInstance, {
	value: (value) => value === "claimed",
});
const claimsBound = bind(Claims);
check("bound target own hasInstance, claimed", "claimed", claimsBound);
check("bound target own hasInstance, other", new Claims(), claimsBound);
check("bound target own hasInstance via chain", "claimed", bind(bind(claimsBound)));
record("Function.prototype[@@hasInstance] on bound with claiming target", () =>
	Function.prototype[Symbol.hasInstance].call(claimsBound, "claimed"),
);

function Replaced() {}
Replaced.prototype = 1;
check("non-object prototype, object", {}, Replaced);
check("non-object prototype, primitive", "text", Replaced);
function DetachedReplaced() {}
Object.setPrototypeOf(DetachedReplaced, null);
DetachedReplaced.prototype = null;
check("null-proto function, null prototype, object", {}, DetachedReplaced);
check("null-proto function, null prototype, primitive", undefined, DetachedReplaced);
check("bound over non-object prototype", {}, bind(Replaced));

function NullPrototypeHolder() {}
Object.setPrototypeOf(NullPrototypeHolder, null);
NullPrototypeHolder.prototype = Object.create(null);
check(
	"null-proto prototype object, matching chain",
	Object.create(NullPrototypeHolder.prototype),
	NullPrototypeHolder,
);
check(
	"null-proto prototype object, null chain",
	Object.create(null),
	NullPrototypeHolder,
);

function OwnHandler() {}
Object.setPrototypeOf(OwnHandler, null);
let handlerThis;
Object.defineProperty(OwnHandler, Symbol.hasInstance, {
	value(value) {
		handlerThis = this;
		return value === 7 ? "yes" : 0;
	},
});
check("own hasInstance on null-proto function, truthy", 7, OwnHandler);
record("own hasInstance receives the right side", () => handlerThis === OwnHandler);
check("own hasInstance on null-proto function, falsy", new OwnHandler(), OwnHandler);

class StaticHandler {
	static [Symbol.hasInstance](value) {
		return typeof value === "string";
	}
}
Object.setPrototypeOf(StaticHandler, null);
check("static hasInstance on null-proto class, string", "s", StaticHandler);
check(
	"static hasInstance on null-proto class, instance",
	new StaticHandler(),
	StaticHandler,
);

function NotCallableHandler() {}
Object.setPrototypeOf(NotCallableHandler, null);
Object.defineProperty(NotCallableHandler, Symbol.hasInstance, { value: 42 });
check("non-callable own hasInstance", {}, NotCallableHandler);
function NullHandler() {}
Object.setPrototypeOf(NullHandler, null);
Object.defineProperty(NullHandler, Symbol.hasInstance, { value: null });
check("null own hasInstance falls back", new NullHandler(), NullHandler);

function Inherits() {}
Object.setPrototypeOf(Inherits, {
	[Symbol.hasInstance]: (value) => value === "inherited",
});
check("hasInstance from a plain-object parent, claimed", "inherited", Inherits);
check("hasInstance from a plain-object parent, instance", new Inherits(), Inherits);
function InheritsNothing() {}
Object.setPrototypeOf(InheritsNothing, Object.create(null));
check("plain-object parent without hasInstance", new InheritsNothing(), InheritsNothing);

const proxied = new Proxy(Detached, {});
check("proxy over null-proto function, instance", detachedInstance, proxied);
check("proxy over null-proto function, plain object", {}, proxied);
const reads = [];
const tracing = new Proxy(Detached, {
	get(target, key, receiver) {
		reads.push(typeof key === "symbol" ? key.description : key);
		return Reflect.get(target, key, receiver);
	},
});
record("proxy reads in order", () => {
	reads.length = 0;
	const result = detachedInstance instanceof tracing;
	return `${result} ${reads.join(",")}`;
});
const answering = new Proxy(Detached, {
	get(target, key, receiver) {
		if (key === Symbol.hasInstance) return () => true;
		return Reflect.get(target, key, receiver);
	},
});
check("proxy supplying hasInstance", {}, answering);
check("proxy over plain object", {}, new Proxy({}, {}));
const revocable = Proxy.revocable(Detached, {});
revocable.revoke();
check("revoked proxy", {}, revocable.proxy);
check("bound proxy over null-proto function", detachedInstance, bind(proxied));

function Target() {}
const targetInstance = new Target();
check("null-proto left side", Object.create(null), Target);
check(
	"left side ending in a null-proto object",
	Object.create(Object.create(null)),
	Target,
);
const deepLeft = Object.create(Target.prototype);
let cursor = deepLeft;
for (let i = 0; i < 100; i++) cursor = Object.create(cursor);
check("left side deeper than the leaf walk", cursor, Target);
let nullCursor = Object.create(null);
for (let i = 0; i < 100; i++) nullCursor = Object.create(nullCursor);
check("null-proto left side deeper than the leaf walk", nullCursor, Target);
const nullTrap = new Proxy(targetInstance, { getPrototypeOf: () => null });
check("left proxy reporting null", nullTrap, Target);
const matchTrap = new Proxy({}, { getPrototypeOf: () => Target.prototype });
check("left proxy reporting the prototype", matchTrap, Target);
const throwingTrap = new Proxy(
	{},
	{
		getPrototypeOf() {
			throw new RangeError("trap");
		},
	},
);
check("left proxy throwing", throwingTrap, Target);
check("null-proto left side against null-proto function", Object.create(null), Detached);

for (let round = 0; round < 3; round++) {
	churn();
	if (globalThis.gc) globalThis.gc();
	record(`round ${round}`, () =>
		[
			detachedInstance instanceof Detached,
			isInstance({}, Detached),
			isInstance(isolatedInstance, Isolated),
			isInstance(detachedInstance, detachedBound),
			isInstance(Object.create(null), Target),
			isInstance(targetInstance, Target),
		].join(","),
	);
}

console.log(log.join("\n"));
