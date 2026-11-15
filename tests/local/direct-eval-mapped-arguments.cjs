function read(first) {
	return eval("arguments.length + ':' + arguments[0] + ':' + first");
}

function retain(value) {
	eval("var introduced = 7");
	return {
		args: arguments,
		read: () => value,
		write(next) {
			value = next;
		},
		introduced: eval("introduced"),
	};
}

function* suspend(value) {
	eval("");
	yield arguments[0];
	value = "updated";
	yield eval("arguments[0]");
}

console.log(read("one", 2, 3));
const retained = retain("initial");
console.log(retained.args[0], retained.read(), retained.introduced);
retained.args[0] = "from argument";
console.log(retained.read());
retained.write("from parameter");
console.log(retained.args[0]);
console.log(JSON.stringify([...suspend("yielded")]));
