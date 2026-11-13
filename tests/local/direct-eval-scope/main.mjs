// A module graph where one module's direct evals see only their own scopes, while
// another module's hot patterns stay private to it.
import { capturedEnds, Meter, restTotal, sumRanges } from "./hot.mjs";
import {
	bumpModule,
	capturedSeen,
	Derived,
	evalSequence,
	makeCounter,
	oddArguments,
	Point,
	readWriteLocals,
	rebindShared,
	restSeen,
	restUnseen,
	shared,
	strictVar,
	Vault,
} from "./scoped.mjs";

const hot = [];
let restSum = 0;
let capturedSum = 0;
const meter = new Meter();
for (let index = 0; index < 400; index++) {
	restSum += restTotal(index, index & 3, 2, 3) + restUnseen(index, 1);
	capturedSum += capturedEnds([index, index + 1, index + 2]);
	meter.record(index & 7);
}
hot.push(sumRanges(300), restSum, capturedSum, meter.sampleTotal());

const scoped = [];
let checksum = 0;
for (let index = 0; index < 200; index++) {
	checksum += readWriteLocals("local += 1; items.push(local); local * 2")[2];
	checksum += bumpModule(1);
	for (const value of evalSequence(index & 7)) checksum += value;
	checksum += restSeen(index & 3, 2);
	checksum += capturedSeen([index, 1], "head() * 2")[0];
}
scoped.push(
	checksum,
	readWriteLocals("local = 'changed'; items.length = 0; typeof items"),
);
scoped.push([...evalSequence(5)], restSeen(1), restUnseen("a", "b"));
scoped.push(
	capturedSeen([4, 5], "values = [9, 8, 7]; values.length"),
	capturedSeen(null, "typeof head"),
);
scoped.push(oddArguments(), strictVar());
const before = shared;
rebindShared({ rebound: true });
scoped.push(before, shared);

const counter = makeCounter();
for (let index = 0; index < 100; index++) counter.add(1);
counter.poke("captured = 'replaced'");
scoped.push(counter.add(1), counter.peek());

const vault = new Vault();
let vaultSum = 0;
for (let index = 0; index < 100; index++) {
	vault.write(index);
	vaultSum += vault.read() + vault.secretTotal();
}
vault.write("s");
scoped.push(vaultSum, vault.read(), vault.secretTotal(), vault.logTotal());

let points = 0;
for (let index = 0; index < 100; index++) points += new Point(index).x;
const [Escaped, receiver] = Point.escaped;
scoped.push(points, new Escaped("7").x, new receiver.constructor("8").x);

const derived = new Derived("tagged");
scoped.push(derived.tag, derived.greet("you"));

console.log(JSON.stringify({ hot, scoped }));
