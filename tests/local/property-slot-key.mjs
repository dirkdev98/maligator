function Base(kind) {
	this.kind = kind;
	this.flags = 0;
}

function read(node) {
	return `${node.kind}:${node.flags}`;
}

const nodes = [];
for (let i = 0; i < 12; i++) {
	const node = new Base(`k${i}`);
	node[`extra${i}`] = i;
	node.flags = i;
	nodes.push(node);
}
const accessor = {};
Object.defineProperty(accessor, "kind", { get: () => "getter", enumerable: true });
accessor.flags = -1;
nodes.push(accessor);
nodes.push({ flags: 7, kind: "swapped" });
nodes.push(Object.freeze(new Base("frozen")));
const dictionary = new Base("dictionary");
delete dictionary.flags;
dictionary.flags = 9;
nodes.push(dictionary);
const prototypeKind = Object.create({ kind: "inherited" });
prototypeKind.flags = 3;
nodes.push(prototypeKind);
nodes.push({ kind: "symbol keyed", [Symbol("flags")]: 1, flags: 4 });

const out = [];
for (let round = 0; round < 3; round++) {
	for (const node of nodes) out.push(read(node));
}
console.log(out.join(" "));
