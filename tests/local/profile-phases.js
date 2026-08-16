function phase(id, run) {
	mal._profilePhaseBegin(id);
	try {
		return run();
	} finally {
		mal._profilePhaseEnd(id);
	}
}

let checksum = 0;
phase(1, () => {
	phase(2, () => {
		for (let index = 0; index < 1_000_000; index++) checksum = (checksum + index) | 0;
	});
});
console.log(checksum);
