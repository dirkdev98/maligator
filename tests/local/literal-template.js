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

function codes() {
	return {
		name: "codes",
		404: "Not Found",
		200: "OK",
		4294967294: "last index",
		4294967295: "not an index",
		"01": "padded",
		"-1": "negative",
		7: "number key",
		nested: { 3: [3], 1: [1], label: "rows" },
		after: true,
	};
}
const firstCodes = codes();
const secondCodes = codes();
ok(
	"index keys enumerate before names",
	Object.keys(firstCodes).join() ===
		"7,200,404,4294967294,name,4294967295,01,-1,nested,after",
);
ok(
	"index keys serialize in order",
	JSON.stringify(firstCodes) ===
		'{"7":"number key","200":"OK","404":"Not Found","4294967294":"last index","name":"codes","4294967295":"not an index","01":"padded","-1":"negative","nested":{"1":[1],"3":[3],"label":"rows"},"after":true}',
);
const indexDescriptor = Object.getOwnPropertyDescriptor(firstCodes, "200");
ok(
	"index keys are ordinary data properties",
	firstCodes[404] === "Not Found" &&
		indexDescriptor.writable &&
		indexDescriptor.enumerable &&
		indexDescriptor.configurable,
);
firstCodes[200] = "changed";
delete firstCodes[404];
ok(
	"index keys stay per instance",
	secondCodes[200] === "OK" && secondCodes[404] === "Not Found" && !(404 in firstCodes),
);
const evalCodes = eval(
	'({ name: "eval", "10": "ten", "9": "nine", a: 1, b: 2, c: 3, d: 4, e: 5, f: 6, g: 7, h: 8 })',
);
ok(
	"eval index keys",
	Object.keys(evalCodes).join() === "9,10,name,a,b,c,d,e,f,g,h" &&
		evalCodes[10] === "ten",
);

function flatRow() {
	return [
		"alpha",
		"beta",
		"gamma",
		"delta",
		"epsilon",
		"zeta",
		"eta",
		"theta",
		"iota",
		"kappa",
		"lambda",
		"mu",
		"nu",
		"xi",
		"omicron",
		"pi",
		-0,
		12n,
		3.5,
		true,
		null,
	];
}
function flatHoles() {
	return [
		"h0",
		,
		"h2",
		"h3",
		"h4",
		"h5",
		"h6",
		"h7",
		"h8",
		"h9",
		"h10",
		"h11",
		"h12",
		"h13",
		"h14",
		"h15",
		"h16",
		,
		"h18",
	];
}
const rows = [flatRow(), flatRow(), flatRow()];
ok("flat array templates are fresh", rows[0] !== rows[1] && rows[1] !== rows[2]);
rows[0][0] = "changed";
rows[0].push("tail");
ok(
	"flat array template isolation",
	rows[1][0] === "alpha" && rows[1].length === 21 && rows[2].length === 21,
);
ok(
	"flat array template constants",
	Object.is(rows[2][16], -0) &&
		rows[2][17] === 12n &&
		rows[2][18] === 3.5 &&
		rows[2][20] === null,
);
const flatDescriptor = Object.getOwnPropertyDescriptor(rows[2], "3");
ok(
	"flat array template elements are ordinary",
	Array.isArray(rows[2]) &&
		Object.getPrototypeOf(rows[2]) === Array.prototype &&
		flatDescriptor.writable &&
		flatDescriptor.enumerable &&
		flatDescriptor.configurable,
);
const holes = [flatHoles(), flatHoles(), flatHoles()];
ok(
	"flat array template holes",
	holes[2].length === 19 &&
		!(1 in holes[2]) &&
		!(17 in holes[2]) &&
		holes[2][18] === "h18",
);
const pieces = [];
for (let i = 0; i < 3; i++) pieces.push("north,east,south".split(","));
ok(
	"folded split stays fresh",
	pieces[0] !== pieces[1] &&
		pieces[1] !== pieces[2] &&
		pieces[2].join("|") === "north|east|south",
);

/* GENERATED_LARGE_TEMPLATE */
console.log("literal-template PASS " + passed + "/" + passed);
