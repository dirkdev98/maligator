// Loops + conditionals + integer/float arithmetic. Bounded memory (no
// allocation inside the hot loops). Exercises nested loops, break/continue,
// modulo, comparisons, and function-call overhead.
//
// Workload: count primes by trial division (nested loop + early break) and
// fold a Collatz step-count over the same range (data-dependent branching).

function countPrimes(limit) {
	let count = 0;
	let checksum = 0;
	for (let n = 2; n < limit; n++) {
		let isPrime = true;
		for (let d = 2; d * d <= n; d++) {
			if (n % d === 0) {
				isPrime = false;
				break;
			}
		}
		if (isPrime) {
			count = count + 1;
			checksum = (checksum + n) % 1000000007;
		}
	}
	return count + checksum;
}

function collatzSteps(start) {
	let steps = 0;
	let n = start;
	while (n > 1) {
		if ((n & 1) === 0) {
			n = n / 2;
		} else {
			n = 3 * n + 1;
		}
		steps = steps + 1;
	}
	return steps;
}

let total = 0;
for (let iter = 0; iter < 12; iter++) {
	total = total + countPrimes(20000);
	let collatz = 0;
	for (let n = 1; n < 20000; n++) {
		collatz = collatz + collatzSteps(n);
	}
	total = (total + collatz) % 2000000011;
}
console.log(total);
