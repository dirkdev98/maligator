globalThis.moduleGcStages = [];

export function probe(stage) {
	const before = globalThis.__moduleGcCount();
	const retained = [];
	for (let index = 0; index < 32; index++) retained.push({ index, stage });
	const after = globalThis.__moduleGcCount();
	if (after <= before) throw new Error(`collection suppressed in ${stage}`);
	if (retained[31].index !== 31 || retained[31].stage !== stage)
		throw new Error(`live values lost in ${stage}`);
	globalThis.moduleGcStages.push(stage);
}
