const api = globalThis as unknown as {
	echo: (input: string) => string;
	fail: () => never;
	badDiagnostic: () => never;
	oversized: () => string;
	retain: (input: string) => string;
};
api.echo = (input) => `echo:${input}`;
api.fail = () => {
	throw new Error("fixture exception");
};
api.badDiagnostic = () => {
	// oxlint-disable-next-line typescript/only-throw-error -- JavaScript permits thrown values whose diagnostic coercion also throws.
	throw {
		toString() {
			throw new Error("diagnostic exception");
		},
	};
};
api.oversized = () => "x".repeat(8 * 1024 * 1024 + 1);
api.retain = (input) => {
	const values = [];
	for (let index = 0; index < 80; index++) values.push({ index, input });
	return JSON.stringify(values);
};

export {};
