const symbols = [];
for (let i = 0; i < 2048; i++) {
	symbols.push(Symbol("gc-symbol-" + i));
}

const captures = [];
for (let i = 0; i < 1024; i++) {
	let held = { id: i };
	captures.push({
		get() {
			return held;
		},
		set(value) {
			held = value;
		},
	});
}

for (let i = 0; i < 200; i++) {
	const temporary = ("gc-concurrent-" + i).repeat(3000);
	if (temporary.length === 0) throw new Error("missing allocation");
	const index = i % captures.length;
	captures[index].set({ id: index + 4096 });
	if (captures[index].get().id !== index + 4096) {
		throw new Error("capture update lost at " + index);
	}
}

for (let i = 0; i < symbols.length; i++) {
	if (symbols[i].description !== "gc-symbol-" + i) {
		throw new Error("symbol lost its description at " + i);
	}
}
for (let i = 0; i < captures.length; i++) {
	const expected = i < 200 ? i + 4096 : i;
	if (captures[i].get().id !== expected) {
		throw new Error("capture lost its value at " + i);
	}
}

console.log("gc-concurrent-workers PASS 1/1");
