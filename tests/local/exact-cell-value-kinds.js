function makeWorker() {
	const step = 3;
	const label = "cell";
	const suffix = "!";
	const wide = 2147483648;
	const signedZero = -0;
	let mutableCounter = 0;

	function int32Leaf() {
		return step;
	}

	function stringLeaf() {
		return label;
	}

	function mutableInt32Leaf() {
		mutableCounter = (mutableCounter + step) | 0;
		return mutableCounter;
	}

	function retainStringAcrossAllocation() {
		const retained = stringLeaf();
		const allocated = { value: int32Leaf() };
		return retained + allocated.value;
	}

	function concatenateKnownStrings() {
		return stringLeaf() + suffix;
	}

	return function work(limit) {
		let total = 0;
		for (let index = 0; index < limit; index++) {
			total = (total + int32Leaf()) | 0;
		}
		return [
			stringLeaf(),
			concatenateKnownStrings(),
			total,
			wide,
			1 / signedZero,
			retainStringAcrossAllocation(),
			mutableInt32Leaf(),
			mutableInt32Leaf(),
		];
	};
}

console.log(JSON.stringify(makeWorker()(10000)));
