function invoke(fn) {
	return fn(undefined, null, false, true, 42, "value", -0);
}

function inspect(a, b, c, d, e, f, g) {
	return `${a === undefined}:${b === null}:${c === false}:${d === true}:${e}:${f}:${Object.is(g, -0)}`;
}

class Box {
	constructor(a, b, c) {
		this.value = `${a === undefined}:${b}:${c}`;
	}
}

function construct(C) {
	return new C(undefined, "text", 7);
}

console.log(invoke(inspect));
console.log(construct(Box).value);
