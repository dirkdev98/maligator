const gc = globalThis.__mal_collect_garbage;
if (typeof gc !== "function") {
	throw new Error("safepoint-satb-exact-roots requires MAL_HOST_GC=1");
}

function* frameWithDeadTarget(round) {
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

let round = 0;
let iterator;
let weak;

function beginRound() {
	iterator = frameWithDeadTarget(round);
	weak = iterator.next().value;
	setTimeout(collectAndResume, 0);
}

function collectAndResume() {
	gc();
	const completion = iterator.next();
	if (!completion.done || completion.value !== round + 1) {
		throw new Error(`generator completion mismatch at round ${round}`);
	}
	gc();
	if (weak.some((ref) => ref.deref() !== undefined)) {
		throw new Error(`a dead target survived at round ${round}`);
	}
	round++;
	if (round < 24) {
		setTimeout(beginRound, 0);
	} else {
		console.log("safepoint-satb-exact-roots PASS");
	}
}

beginRound();
