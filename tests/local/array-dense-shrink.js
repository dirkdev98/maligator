// Generic pop/shift and length truncation shrink dense Arrays in place. The
// receiver must stay a plain dense Array so later method loads keep their
// inherited caches; the observable semantics below must match the spec.
const results = [];
function check(name, ok) {
	results.push([name, ok]);
}

const values = [1, 2, 3, 4];
let checksum = 0;
for (let round = 0; round < 2048; round++) {
	values.push(round, round + 1);
	checksum += values.pop();
	checksum += values.shift();
	values.unshift(round & 255);
	values.length = 4;
}
check("deque length", values.length === 4);
check("deque checksum", checksum === 2359042);

const truncated = [10, 20, 30, 40, 50];
truncated.length = 2;
check("truncate length", truncated.length === 2);
check("truncate drops tail", truncated[3] === undefined && !(3 in truncated));
truncated.length = 4;
check(
	"regrow leaves holes",
	truncated.length === 4 && !(2 in truncated) && truncated[1] === 20,
);

const holey = [1, , 3, , 5];
check("holey pop", holey.pop() === 5 && holey.length === 4);
check("holey pop hole", holey.pop() === undefined && holey.length === 3 && !(1 in holey));

const sealed = Object.seal([1, 2, 3]);
let sealedShrinkThrew = false;
try {
	sealed.length = 1;
} catch (error) {
	sealedShrinkThrew = error instanceof TypeError;
}
check(
	"sealed shrink blocked",
	sealedShrinkThrew && sealed.length === 3 && sealed[2] === 3,
);
let sealedPopThrew = false;
try {
	sealed.pop();
} catch (error) {
	sealedPopThrew = error instanceof TypeError;
}
check("sealed pop throws", sealedPopThrew && sealed.length === 3);

const named = [1, 2, 3];
named.label = "kept";
named.pop();
check("named property survives shrink", named.label === "kept" && named.length === 2);

let passed = 0;
for (const [name, ok] of results) {
	if (ok) passed++;
	else console.log("FAIL: " + name);
}
console.log("RESULT " + passed + "/" + results.length);
