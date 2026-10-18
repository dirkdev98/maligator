"use strict";

function expectKeys(object, expected, message) {
	const keys = [];
	for (const key in object) keys.push(key);
	const actual = keys.join(",");
	if (actual !== expected) throw new Error(`${message}: ${actual} !== ${expected}`);
}

const symbol = Symbol("hidden");
const plain = { b: 1, a: 2, 2: "two", 1: "one", [symbol]: 3 };
Object.defineProperty(plain, "quiet", { value: 4, enumerable: false });
expectKeys(plain, "1,2,b,a", "own keys in property order without symbols or hidden keys");

class Point {
	constructor(x, y) {
		this.x = x;
		this.y = y;
	}
	length() {
		return Math.hypot(this.x, this.y);
	}
}
expectKeys(new Point(1, 2), "x,y", "class methods are not enumerable");

const bare = Object.create(null);
bare.only = true;
expectKeys(bare, "only", "no prototype");

for (let round = 0; round < 3; round++)
	expectKeys({ c: 1, d: 2 }, "c,d", "warm silent chain");

Object.prototype.added = 1;
expectKeys({ c: 1 }, "c,added", "an enumerable key added to Object.prototype");
expectKeys({ added: 2 }, "added", "an own key shadows the prototype key");
delete Object.prototype.added;
expectKeys({ c: 1 }, "c", "the deleted prototype key disappears");

const parent = { inherited: 1 };
const child = Object.create(parent);
child.own = 2;
expectKeys(child, "own,inherited", "enumerable prototype keys follow own keys");
Object.defineProperty(parent, "inherited", { enumerable: false });
expectKeys(child, "own", "a prototype key made non-enumerable");
Object.defineProperty(parent, "shadowed", { value: 1, enumerable: false });
Object.setPrototypeOf(parent, { shadowed: 2, visible: 3 });
expectKeys(child, "own,visible", "a non-enumerable key shadows further up the chain");

const accessorParent = {};
Object.defineProperty(accessorParent, "computed", {
	get: () => 1,
	enumerable: true,
});
expectKeys(Object.create(accessorParent), "computed", "an enumerable prototype accessor");

const list = [10, 20, 30];
list.extra = true;
expectKeys(list, "0,1,2,extra", "array indices then named keys");
for (let round = 0; round < 3; round++)
	expectKeys([1, , 3], "0,2", "a warm silent array prototype");
const holey = [1, , 3];
holey["01"] = "named";
function readByStrings(array) {
	return ["0", "1", "2", "01", "3"].map((key) => String(array[key])).join(",");
}
for (let round = 0; round < 3; round++)
	if (readByStrings(holey) !== "1,undefined,3,named,undefined")
		throw new Error(`index strings read ${readByStrings(holey)}`);
Array.prototype[1] = "inherited";
expectKeys([1, , 3], "0,2,1", "an element added to Array.prototype fills the hole");
if (readByStrings(holey) !== "1,inherited,3,named,undefined")
	throw new Error(`an index string reaches the prototype: ${readByStrings(holey)}`);
delete Array.prototype[1];
expectKeys([1, , 3], "0,2", "the deleted prototype element disappears");

let total = 0;
const counted = { alpha: 1, beta: 2, gamma: 3 };
for (let i = 0; i < 1000; i++) for (const key in counted) total += counted[key];
if (total !== 6000) throw new Error(`repeated enumeration total ${total}`);

console.log("native-for-in-own-keys PASS");
