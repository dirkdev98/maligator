const gc = globalThis.__mal_collect_garbage,
	other = $262.createRealm().global,
	rows = [];
function project(value, start, count) {
	const part = value.substr(start, count);
	gc?.();
	return [part.length, part.lastIndexOf("a"), `${part}`];
}
function search(value, needle, position) {
	const part = value.slice(1, -1);
	const found = part.lastIndexOf(needle, position);
	gc?.();
	return [found, part.length];
}
const substr = String.prototype.substr,
	last = String.prototype.lastIndexOf;
String.prototype.substr = other.String.prototype.substr;
String.prototype.lastIndexOf = other.String.prototype.lastIndexOf;
rows.push(project("ababa", -4, 3), search("xababaz", "a", Infinity));
for (const run of [
	() => project("ababa", Symbol("start"), 2),
	() => search("xabaz", Symbol("needle"), 0),
	() => search("xabaz", "a", Symbol("position")),
]) {
	try {
		run();
	} catch (error) {
		rows.push(error instanceof other.TypeError, error instanceof TypeError);
	}
}
const events = [],
	boxed = new String("ababa");
boxed.toString = () => {
	events.push("receiver");
	gc?.();
	return "ababa";
};
rows.push(
	project(
		boxed,
		{
			valueOf() {
				events.push("start");
				gc?.();
				return 1;
			},
		},
		3,
	),
);
const needle = {
	get [Symbol.match]() {
		throw new Error("wrong protocol");
	},
	toString() {
		events.push("needle");
		String.prototype.lastIndexOf = () => -73;
		gc?.();
		return "a";
	},
};
rows.push(
	search("xabaz", needle, {
		valueOf() {
			events.push("position");
			return Infinity;
		},
	}),
	search("xabaz", "a", Infinity),
);
String.prototype.substr = substr;
String.prototype.lastIndexOf = last;
rows.push(events);
console.log(JSON.stringify(rows));
