function expectValue(actual, expected, message) {
	if (!Object.is(actual, expected)) {
		throw new Error(message + ": " + String(actual) + " !== " + String(expected));
	}
}

function stepParticle(particle, scale) {
	particle.vy += 0.01 * particle.mass;
	particle.x += particle.vx;
	particle.y += particle.vy;
	if (particle.y > 1000) particle.y = -particle.y * scale;
	if (particle.x > 5000) particle.x = particle.x % 97;
	return particle.x - particle.y;
}

// The same operations on array slots, which no record region admits.
function stepReference(state, scale) {
	state[3] += 0.01 * state[4];
	state[0] += state[2];
	state[1] += state[3];
	if (state[1] > 1000) state[1] = -state[1] * scale;
	if (state[0] > 5000) state[0] = state[0] % 97;
	return state[0] - state[1];
}

function mixBits(record) {
	record.flags = (record.flags | 4) ^ record.mask;
	record.count = ~record.count + (record.count >>> 1);
	record.rest = record.rest % 7;
	if (!(record.flags & 1)) record.count++;
	return record.flags;
}

function mixReference(state) {
	state[0] = (state[0] | 4) ^ state[1];
	state[2] = ~state[2] + (state[2] >>> 1);
	state[3] = state[3] % 7;
	if (!(state[0] & 1)) state[2]++;
	return state[0];
}

function grows(record) {
	record.left = record.left * 2;
	record.right = record.right + 1;
	const ahead = record.left > record.right;
	record.total = record.left + record.right;
	return ahead;
}

function particleState(particle) {
	return [particle.x, particle.y, particle.vx, particle.vy, particle.mass];
}

function sameState(particle, state, message) {
	expectValue(particle.x, state[0], message + " x");
	expectValue(particle.y, state[1], message + " y");
	expectValue(particle.vx, state[2], message + " vx");
	expectValue(particle.vy, state[3], message + " vy");
	expectValue(particle.mass, state[4], message + " mass");
}

const particles = [];
for (let index = 0; index < 64; index++) {
	particles.push({
		x: index * 0.5,
		y: -index * 0.25,
		vx: (index % 13) - 6,
		vy: (index % 7) - 3,
		mass: (index % 9) + 1,
	});
}
const states = particles.map(particleState);
for (let step = 0; step < 400; step++) {
	for (let index = 0; index < particles.length; index++) {
		expectValue(
			stepParticle(particles[index], 0.5),
			stepReference(states[index], 0.5),
			"particle result",
		);
	}
}
for (let index = 0; index < particles.length; index++) {
	sameState(particles[index], states[index], "particle " + index);
}

const zero = { x: 0, y: 0, vx: 0, vy: 0, mass: 0 };
expectValue(stepParticle(zero, -1), 0, "integral zero stays integral");
zero.y = 2000;
stepParticle(zero, 0);
expectValue(zero.y, -0, "negative zero widens an integer field");

const nan = { x: 1, y: 2, vx: 3, vy: 4, mass: NaN };
expectValue(stepParticle(nan, 0.5), NaN, "NaN propagates through the region");
expectValue(nan.vy, NaN, "NaN is stored");

const text = { x: 1, y: 2, vx: "3", vy: 4, mass: 1 };
const textState = particleState(text);
expectValue(
	stepParticle(text, 0.5),
	stepReference(textState, 0.5),
	"string field result",
);
sameState(text, textState, "string field");

const boxedScale = { x: 1, y: 2000, vx: 1, vy: 1, mass: 1 };
const boxedScaleState = particleState(boxedScale);
expectValue(
	stepParticle(boxedScale, "0.5"),
	stepReference(boxedScaleState, "0.5"),
	"string input result",
);
sameState(boxedScale, boxedScaleState, "string input");

let getterCalls = 0;
let backingX = 10;
const accessor = { y: 1, vx: 2, vy: 3, mass: 4 };
Object.defineProperty(accessor, "x", {
	get() {
		getterCalls++;
		return backingX;
	},
	set(value) {
		backingX = value * 2;
	},
	enumerable: true,
	configurable: true,
});
const accessorState = [10, 1, 2, 3, 4];
stepParticle(accessor, 0.5);
accessorState[3] += 0.01 * accessorState[4];
accessorState[0] = (accessorState[0] + accessorState[2]) * 2;
accessorState[1] += accessorState[3];
expectValue(backingX, accessorState[0], "accessor setter runs");
expectValue(accessor.y, accessorState[1], "accessor receiver keeps data fields");
expectValue(getterCalls, 3, "accessor getter runs for every original read");

const frozen = Object.freeze({ x: 1, y: 2, vx: 3, vy: 4, mass: 5 });
try {
	stepParticle(frozen, 0.5);
} catch (error) {
	expectValue(error instanceof TypeError, true, "strict frozen store throws a TypeError");
}
expectValue(frozen.vy, 4, "frozen field keeps its value");

const prototype = { x: 1, y: 2, vx: 3, vy: 4, mass: 5 };
const derived = Object.create(prototype);
const prototypeState = particleState(prototype);
expectValue(
	stepParticle(prototype, 0.5),
	stepReference(prototypeState, 0.5),
	"prototype receiver result",
);
sameState(prototype, prototypeState, "prototype receiver");
expectValue(derived.x, prototype.x, "derived object observes the prototype store");

const records = [];
const recordStates = [];
for (let index = 0; index < 32; index++) {
	records.push({ flags: index, mask: index * 3, count: index - 16, rest: index * 1.5 });
	recordStates.push([index, index * 3, index - 16, index * 1.5]);
}
for (let round = 0; round < 50; round++) {
	for (let index = 0; index < records.length; index++) {
		expectValue(mixBits(records[index]), mixReference(recordStates[index]), "mixed bits");
	}
}
for (let index = 0; index < records.length; index++) {
	expectValue(records[index].flags, recordStates[index][0], "flags");
	expectValue(records[index].count, recordStates[index][2], "count");
	expectValue(records[index].rest, recordStates[index][3], "rest");
}

const growth = { left: 1, right: 0, total: 0 };
const answers = [];
for (let round = 0; round < 8; round++) answers.push(grows(growth));
expectValue(answers.join(), "true,true,true,true,true,true,true,true", "boolean result");
expectValue(growth.total, 256 + 8, "total");

console.log("native-number-record-regions PASS");
