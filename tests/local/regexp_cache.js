const results = [];

function check(name, condition) {
	results.push([name, condition]);
}

const objects = [];
for (let i = 0; i < 100; i++) objects.push(new RegExp("(a)(b)?", "g"));

check("fresh objects keep distinct identity", objects[0] !== objects[1]);

const first = objects[0];
const second = objects[1];
first.lastIndex = 1;
second.lastIndex = 0;
const firstMatch = first.exec("zab");
const secondMatch = second.exec("a");
check(
	"shared patterns keep independent lastIndex",
	first.lastIndex === 3 && second.lastIndex === 1,
);
check(
	"shared patterns keep independent captures",
	firstMatch[0] === "ab" &&
		firstMatch[2] === "b" &&
		secondMatch[0] === "a" &&
		secondMatch[2] === undefined,
);

check(
	"different flags do not alias",
	!new RegExp("a").test("A") && new RegExp("a", "i").test("A"),
);

const locked = /a/g;
locked.lastIndex = 2;
const writableDescriptor = Object.getOwnPropertyDescriptor(locked, "lastIndex");
Object.defineProperty(locked, "lastIndex", { writable: false });
const lockedSet = Reflect.set(locked, "lastIndex", 7);
const lockedDescriptor = Object.getOwnPropertyDescriptor(locked, "lastIndex");
check(
	"lastIndex updates preserve descriptor state",
	writableDescriptor.value === 2 &&
		writableDescriptor.writable === true &&
		writableDescriptor.enumerable === false &&
		writableDescriptor.configurable === false &&
		lockedSet === false &&
		lockedDescriptor.value === 2 &&
		lockedDescriptor.writable === false &&
		lockedDescriptor.enumerable === false &&
		lockedDescriptor.configurable === false,
);

let invalidCount = 0;
for (let i = 0; i < 2; i++) {
	try {
		new RegExp("(");
	} catch (error) {
		if (error instanceof SyntaxError) invalidCount++;
	}
}
check("invalid patterns still throw", invalidCount === 2);

let passed = 0;
for (const [name, condition] of results) {
	if (condition) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
