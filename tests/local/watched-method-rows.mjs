// Method and namespace loads after a polyfill installed methods on watched built-ins
// at startup, then replaced, reparented and restored between and inside warm loops.
const results = [];
function record(label, value) {
	results[results.length] = `${label}=${value}`;
}

Object.defineProperty(String.prototype, "myHelper", {
	value() {
		return this.length;
	},
	writable: true,
	configurable: true,
});
Object.defineProperty(Object.prototype, "myObjectHelper", {
	value: () => "object",
	writable: true,
	configurable: true,
});
Math.clampTo = (value, low, high) => Math.min(Math.max(value, low), high);

const originalCharCodeAt = String.prototype.charCodeAt;
const originalFloor = Math.floor;
const originalPush = Array.prototype.push;

function codes(text) {
	let total = 0;
	for (let index = 0; index < text.length; index++) total += text.charCodeAt(index);
	return total;
}

function floors(limit) {
	let total = 0;
	for (let index = 0; index < limit; index++) total += Math.floor(index / 3);
	return total;
}

// `later` is absent until a define below adds it to String.prototype.
function laterOf(text) {
	return typeof text.later === "function" ? text.later() : "absent";
}

function pushes(count) {
	const values = [];
	try {
		for (let index = 0; index < count; index++) values.push(index);
	} catch (error) {
		return error.constructor.name;
	}
	return values.join(" ");
}

function round(label) {
	record(label, [codes("watched rows"), floors(12), laterOf("x"), pushes(4)].join(","));
}

const loops = 200;
let warm = 0;
for (let index = 0; index < loops; index++) {
	warm += codes("polyfilled text") + floors(8) + laterOf("y").length + pushes(3).length;
}
record("warm", warm);
record("loops", loops);
round("intact");

String.prototype.charCodeAt = function (index) {
	return originalCharCodeAt.call(this, index) + 1;
};
round("charCodeAt");
String.prototype.charCodeAt = originalCharCodeAt;
round("charCodeAt.restored");

// Replaced from inside a loop that already read the method.
let inside = 0;
const text = "abcdef";
for (let index = 0; index < text.length; index++) {
	if (index === 3) {
		String.prototype.charCodeAt = function () {
			return 1000;
		};
	}
	inside += text.charCodeAt(index);
}
String.prototype.charCodeAt = originalCharCodeAt;
record("charCodeAt.inside", inside);

Math.floor = (value) => originalFloor(value) * 2;
round("floor");
Math.floor = originalFloor;

String.prototype.later = function () {
	return `later:${this}`;
};
round("later");
delete String.prototype.later;
round("later.deleted");

Array.prototype.push = function (value) {
	this[this.length] = value * 2;
	return this.length;
};
round("push");
delete Array.prototype.push;
round("push.deleted");
Array.prototype.push = originalPush;
round("push.restored");

// A reparented String.prototype resolves methods through an object no protector
// watches, so later changes to that object must stay visible.
const StringPrototypeParent = Object.getPrototypeOf(String.prototype);
const intermediate = Object.create(StringPrototypeParent);
Object.setPrototypeOf(String.prototype, intermediate);
intermediate.later = function () {
	return `intermediate:${this}`;
};
round("reparented");
intermediate.later = function () {
	return `changed:${this}`;
};
round("reparented.changed");
delete intermediate.later;
round("reparented.deleted");
Object.setPrototypeOf(String.prototype, StringPrototypeParent);
round("final");

console.log(results.join("\n"));
