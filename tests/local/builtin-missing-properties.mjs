// A site reading names that objects own but strings, numbers and arrays lack, before
// and after scripts add those names to the builtin prototypes.
function kinds(values) {
	const seen = [];
	for (const value of values) seen.push(value.type, value.kind);
	return seen.join(",");
}
const plain = [{ type: "group", kind: 1 }, "text", ["part"], 7, true, { type: "line" }];
const log = [];
for (let round = 0; round < 3; round++) log.push(kinds(plain));

const ownType = ["own"];
ownType.type = "array-own";
const reparented = ["reparented"];
Object.setPrototypeOf(reparented, { type: "custom-proto" });
log.push(kinds([ownType, reparented, "text"]));

String.prototype.type = "string-proto";
log.push(kinds(plain));
Array.prototype.kind = "array-proto";
log.push(kinds(plain));
Object.prototype.type = "object-proto";
log.push(kinds(plain), kinds([1.5, false, []]));
delete String.prototype.type;
log.push(kinds(plain));

const indexed = "abc";
log.push(indexed.length, indexed[1], [1, 2].length);
console.log(log.join("\n"));
