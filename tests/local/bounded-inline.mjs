function closed(value) {
	function early(input) {
		const numeric = +input;
		if (numeric < 0) return -numeric;
		if (numeric === 0) return 1 / numeric;
		return numeric + 1;
	}
	function diamond(input) {
		let result;
		if (input > 2) result = input * 2;
		else result = input - 3;
		return result + 4;
	}
	try {
		return [early(value), diamond(value)].map(String).join(",");
	} catch (error) {
		return error.name;
	}
}
let effects = 0;
for (const input of [
	-4,
	-0,
	0,
	2,
	8,
	undefined,
	null,
	true,
	"3",
	{
		valueOf() {
			effects++;
			return -5;
		},
	},
	Symbol("x"),
])
	console.log(closed(input));
console.log("effects", effects);
function makeOpen() {
	let callback = (input) => {
		if (input > 2) return input + 8;
		return input * 3;
	};
	function install(other) {
		callback = other;
	}
	function invoke(input) {
		try {
			return callback(input) + 1;
		} catch (error) {
			return error.message;
		}
	}
	return { install, invoke };
}
const open = makeOpen();
console.log(open.invoke(1), open.invoke(3));
open.install((input) => {
	if (input === 3) throw new Error("replacement");
	return input - 9;
});
console.log(open.invoke(1), open.invoke(3));
