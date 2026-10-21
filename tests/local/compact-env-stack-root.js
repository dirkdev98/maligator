// The running frame's per-iteration scope is the only holder of the function scope:
// every closure over either scope is already garbage when collections run.
function churn(round) {
	let items = [];
	for (let index = 0; index < 16; index++)
		items.push({ index, text: `x${round}:${index}` });
	return items.length;
}

function run(rounds) {
	let count = rounds;
	globalThis.compactEnvSink = () => count++;
	globalThis.compactEnvSink();
	globalThis.compactEnvSink = null;
	let sum = 0;
	for (let round = 0; round < rounds; round++) {
		globalThis.compactEnvSink = () => round;
		globalThis.compactEnvSink = null;
		sum += churn(round);
		sum += count + round;
	}
	return sum;
}

let total = 0;
for (let repeat = 0; repeat < 4; repeat++) total += run(60);
console.log(`compact-env-stack-root ${total}`);
