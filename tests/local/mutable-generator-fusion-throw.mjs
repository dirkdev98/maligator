// A for-of loop over a private generator that entered with the protocol intact and
// throws out of its body after the body replaced %GeneratorPrototype%.return.
const results = [];
function record(label, value) {
	results.push(`${label}=${value}`);
}

const GeneratorPrototype = Object.getPrototypeOf(function* () {}).prototype;
const originalNext = GeneratorPrototype.next;

function* sequence(seed) {
	for (let index = 0; index < 7; index++) yield (seed * 3 + index) & 31;
}

function throwing(seed, observe) {
	let total = 0;
	let position = 0;
	try {
		for (const value of sequence(seed | 0)) {
			total += value;
			observe(position++);
		}
	} catch (error) {
		return `${total}:${error}`;
	}
	return `${total}`;
}

// Every caller reaches the loop through this, so it stays one site.
const consumers = [throwing];

const loops = 40;
let warm = 0;
const quiet = () => {};
for (let round = 0; round < loops; round++)
	for (let seed = 0; seed < 8; seed++)
		warm += Number.parseInt(consumers[0](seed + round, quiet), 10);
record("warm", warm);
record("loops", loops);

// The replaced `return` sees the suspended generator, and its own error loses to
// the one leaving the loop.
const seen = [];
record(
	"inside",
	consumers[0](4, (position) => {
		if (position === 2) {
			GeneratorPrototype.return = function () {
				const rest = [];
				for (
					let step = originalNext.call(this);
					!step.done;
					step = originalNext.call(this)
				)
					rest.push(step.value);
				seen.push(`return:${rest.join(" ")}`);
				throw new Error("ignored");
			};
			throw "stopped";
		}
	}),
);
record("inside.seen", seen.join(","));
record(
	"after",
	consumers[0](6, (position) => {
		if (position === 4) throw "again";
	}),
);
record("after.seen", seen.join(","));

console.log(results.join("\n"));
