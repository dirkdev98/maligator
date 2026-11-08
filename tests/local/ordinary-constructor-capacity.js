const observations = [];
const collect = typeof gc === "function" ? gc : () => {};

function Pair(left, right) {
	this.left = left;
	this.right = right;
}

const PairConstructor = new Proxy(Pair, {});
const kept = [];
for (let index = 0; index < 64; index++) {
	kept.push(new PairConstructor(index, kept.at(-1)));
}
collect();
observations.push([kept.at(-1).left, kept.at(-1).right === kept.at(-2)]);

const grown = kept[0];
grown.extra = "third";
grown.tail = "fourth";
delete grown.left;
Object.defineProperty(grown, "right", { get: () => "accessor" });
collect();
observations.push([Object.keys(grown), grown.extra, grown.tail, grown.right]);

function Conditional(flag) {
	if (flag) this.first = "first";
	this.second = "second";
}
observations.push([
	Object.keys(new Conditional(false)),
	Object.keys(new Conditional(true)),
]);

function SetterPair(left, right) {
	this.left = left;
	this.right = right;
}
const setterObservations = [];
Object.defineProperty(SetterPair.prototype, "right", {
	set(value) {
		collect();
		setterObservations.push([value, Object.keys(this), Object.hasOwn(this, "right")]);
	},
});
const setterPair = new SetterPair(3, 4);
observations.push([setterObservations, setterPair.left, Object.keys(setterPair)]);

function Observed(observer) {
	observer(this);
	this.left = "left";
	this.right = "right";
}
const observed = new Observed((receiver) => {
	observations.push(Object.keys(receiver));
	collect();
});
observations.push(Object.keys(observed));

function Constrained(block) {
	"use strict";
	block(this);
	this.left = 1;
	this.right = 2;
}
let blockedReceiver;
let blocked = false;
try {
	new new Proxy(Constrained, {})((receiver) => {
		blockedReceiver = receiver;
		Object.preventExtensions(receiver);
		collect();
	});
} catch (error) {
	blocked = error instanceof TypeError;
}
observations.push([
	blocked,
	Object.keys(blockedReceiver),
	Object.isExtensible(blockedReceiver),
]);

function Returning() {
	this.temporary = "temporary";
	return { replacement: true };
}
observations.push(Object.keys(new Returning()));

const target = { existing: true };
Pair.call(target, 7, 8);
observations.push([Object.keys(target), target.left, target.right]);

function Other() {}
Other.prototype.tag = "other";
const alternate = Reflect.construct(Pair, [9, 10], Other);
observations.push([
	Object.getPrototypeOf(alternate) === Other.prototype,
	alternate.tag,
	alternate.left,
	alternate.right,
]);
console.log(JSON.stringify(observations));
