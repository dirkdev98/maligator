import { runRuntimeGapCase } from "../case-runner.mjs";

const MODULUS = 1_000_000_007;

function normalized(value) {
	const result = value % MODULUS;
	return result < 0 ? result + MODULUS : result;
}

function result(checksum, operations) {
	return { checksum: normalized(checksum), operations };
}

function* numberSequence(seed) {
	for (let index = 0; index < 8; index++) yield seed + index * 3;
}

function generatorIteratorSemantics(scale) {
	let checksum = 0;
	let operations = 0;
	for (let round = 0; round < 20 * scale; round++) {
		function* sentValues() {
			const sent = yield { value: round + 1 };
			return sent + 3;
		}
		const sent = sentValues();
		const first = sent.next();
		const second = sent.next(round + 5);
		const third = sent.next();
		checksum +=
			first.value.value +
			second.value +
			(second.done ? 11 : 0) +
			(third.done ? 13 : 0) +
			(first !== second && second !== third ? 17 : 0);
		operations += 3;

		let mutating;
		let originalNext;
		const replacementError = {};
		function* mutateNext() {
			mutating.next = () => {
				throw replacementError;
			};
			try {
				yield round + 2;
				yield round + 4;
			} finally {
				mutating.next = originalNext;
			}
		}
		mutating = mutateNext();
		originalNext = mutating.next;
		Object.defineProperty(mutating, "next", {
			value: originalNext,
			writable: true,
			configurable: true,
		});
		for (const value of mutating) checksum += value;
		operations += 2;

		let nextGets = 0;
		let doneGets = 0;
		let valueGets = 0;
		const wrappedSource = numberSequence(round);
		const wrapped = {
			[Symbol.iterator]() {
				return this;
			},
			get next() {
				nextGets++;
				return () => {
					const step = wrappedSource.next();
					return {
						get done() {
							doneGets++;
							return step.done;
						},
						get value() {
							valueGets++;
							return step.value;
						},
					};
				};
			},
		};
		for (const value of wrapped) checksum += value;
		checksum += nextGets * 19 + doneGets * 23 + valueGets * 29;
		operations += 8;

		const thrown = {};
		let finalized = 0;
		function* throwsFromBody() {
			try {
				yield round;
				throw thrown;
			} finally {
				finalized++;
			}
		}
		try {
			for (const value of throwsFromBody()) checksum += value;
		} catch (error) {
			checksum += error === thrown ? 31 : 0;
		}

		function* closesEarly() {
			try {
				yield round + 7;
				yield round + 9;
			} finally {
				finalized++;
			}
		}
		for (const value of closesEarly()) {
			checksum += value;
			break;
		}
		checksum += finalized * 37;
		operations += 3;

		function* delegated() {
			return yield* (function* () {
				yield round + 11;
				return round + 13;
			})();
		}
		const delegation = delegated();
		const delegatedYield = delegation.next();
		const delegatedReturn = delegation.next();
		checksum +=
			delegatedYield.value +
			(delegatedYield.done ? 0 : 41) +
			delegatedReturn.value +
			(delegatedReturn.done ? 43 : 0);
		operations += 2;
	}
	return result(checksum, operations);
}

runRuntimeGapCase("generator-iterator-semantics", generatorIteratorSemantics);
