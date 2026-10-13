const foreign = $262.createRealm().global;
const callback = foreign.Function(
	"value",
	"index",
	"if(this!==globalThis||arguments.length!==2)throw new Error('foreign callback'); return index === 1",
);
const result = Iterator.prototype.find.call([2, 3, 4].values(), callback);
let calls = 0;
function local(value, index) {
	"use strict";
	if (this !== undefined || arguments.length !== 2)
		throw new Error("local callback realm");
	calls++;
	return index === 1;
}
const other = foreign.Iterator.prototype.some.call([2, 3, 4].values(), local);
const total = foreign.Iterator.prototype.reduce.call(
	[2, 3].values(),
	function sum(acc, value, index) {
		"use strict";
		if (this !== undefined || arguments.length !== 3) throw new Error("reduce realm");
		return acc + value + index;
	},
	0,
);
if (result !== 3 || other !== true || calls !== 2 || total !== 6)
	throw new Error("realm results");
console.log("iterator-realms", result, other, calls, total);
