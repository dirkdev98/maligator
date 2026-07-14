let passed = 0;
function ok(name, condition) {
	if (!condition) throw new Error("FAIL " + name);
	passed++;
}

function make() {
	return [
		{ label: "outer", nested: [1, , { value: "inner" }] },
		-0,
		true,
		null,
		1234567890123,
		77n,
	];
}

const first = make();
const second = make();
ok("fresh root", first !== second);
ok("fresh nested object", first[0] !== second[0]);
ok("fresh nested array", first[0].nested !== second[0].nested);
ok("fresh nested leaf object", first[0].nested[2] !== second[0].nested[2]);
ok("hole and length", first[0].nested.length === 3 && !(1 in first[0].nested));
ok("minus zero", Object.is(first[1], -0) && 1 / first[1] === -Infinity);
ok("f64", first[4] === 1234567890123);
ok("bigint", first[5] === 77n);
ok(
	"string value and key",
	first[0].label === "outer" && first[0].nested[2].value === "inner",
);
ok(
	"ordinary prototypes",
	Object.getPrototypeOf(first) === Array.prototype &&
		Object.getPrototypeOf(first[0]) === Object.prototype,
);

first[0].label = "changed";
first[0].nested[2].value = "mutated";
first.push("tail");
ok(
	"mutation isolation",
	second[0].label === "outer" &&
		second[0].nested[2].value === "inner" &&
		second.length === 6,
);

const evalValue = eval(
	'["eval-string", { evalKey: "eval-value" }, -0, 99n, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]',
);
ok("eval string pool", evalValue[0] === "eval-string");
ok("eval key pool", evalValue[1].evalKey === "eval-value");
ok("eval f64 identity", Object.is(evalValue[2], -0));
ok("eval f64 bits", 1 / evalValue[2] === -Infinity);
ok("eval bigint pool", evalValue[3] === 99n);

/* GENERATED_LARGE_TEMPLATE */
console.log("literal-template PASS " + passed + "/" + passed);
