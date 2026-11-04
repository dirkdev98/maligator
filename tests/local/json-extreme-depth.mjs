const mode = process.argv[2];
const shape = process.argv[3];
const depth = 100_000;
const array = shape === "array";
const prefix = array ? "[" : '{"next":';
const suffix = array ? "]" : "}";
const text = prefix.repeat(depth) + "0" + suffix.repeat(depth);
let visits = 0;
let value;
if (mode === "parse" || mode === "reviver") {
	value =
		mode === "parse"
			? JSON.parse(text)
			: JSON.parse(text, (key, value, context) => {
					visits++;
					if (value === 0 && context.source !== "0")
						throw new Error("Missing source context");
					return value;
				});
	for (let i = 0; i < depth; i++) value = array ? value[0] : value.next;
	if (value !== 0 || (mode === "reviver" && visits !== depth + 1))
		throw new Error("Incomplete traversal");
} else {
	value = 0;
	for (let i = 0; i < depth; i++) value = array ? [value] : { next: value };
	const result =
		mode === "stringify"
			? JSON.stringify(value)
			: JSON.stringify(value, (key, value) => {
					visits++;
					return value;
				});
	if (result !== text || (mode === "replacer" && visits !== depth + 1))
		throw new Error("Incomplete serialization");
}
console.log(`${mode} ${shape} ${depth} PASS`);
