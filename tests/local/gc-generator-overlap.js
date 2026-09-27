function* heldDuringWorker() {
	const token = { marker: 181 };
	__gcObserveToken(token);
	yield 1;
	return token.marker;
}

globalThis.__gcMakeGenerator = heldDuringWorker;
