const foreign = $262.createRealm().global;
const callback = foreign.Function(
	"value",
	"index",
	"if(this!==globalThis||arguments.length!==2)throw new Error('foreign');return value+index",
);
const helper = Iterator.prototype.map.call([2, 3].values(), callback);
if (helper.next().value !== 2 || helper.toArray().join() !== "4")
	throw new Error("foreign retained callback");
function local(value, index) {
	"use strict";
	if (this !== undefined || arguments.length !== 2) throw new Error("local");
	return value + index;
}
const other = foreign.Iterator.prototype.map.call([4, 5].values(), local);
if (other.next().value !== 4 || other.toArray().join() !== "6")
	throw new Error("borrowed realm");
console.log("retained-realms", "2,4", "4,6");
