function* suspendedFrame(round) {
	const dead0 = { round, slot: 0 };
	const dead1 = { round, slot: 1 };
	const dead2 = { round, slot: 2 };
	const dead3 = { round, slot: 3 };
	const dead4 = { round, slot: 4 };
	const weak = [
		new WeakRef(dead0),
		new WeakRef(dead1),
		new WeakRef(dead2),
		new WeakRef(dead3),
		new WeakRef(dead4),
	];
	yield weak;
	return round + 1;
}

globalThis.__satbGenerator = suspendedFrame(16);
globalThis.__satbWeak = globalThis.__satbGenerator.next().value[0];
