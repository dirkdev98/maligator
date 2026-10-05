export async function scheduleTestJobs<Input, Output>(
	inputs: ReadonlyArray<Input>,
	concurrency: number,
	run: (input: Input, index: number) => Promise<Output>,
	shouldStart: () => boolean = () => true,
): Promise<Map<Input, Output>> {
	if (!Number.isSafeInteger(concurrency) || concurrency < 1) {
		throw new RangeError("test concurrency must be a positive integer");
	}
	let next = 0;
	const completed = new Map<number, Output>();
	const drain = async () => {
		while (next < inputs.length && shouldStart()) {
			const index = next++;
			completed.set(index, await run(inputs[index]!, index));
		}
	};
	const settled = await Promise.allSettled(
		Array.from({ length: Math.min(concurrency, inputs.length) }, drain),
	);
	const failures = settled.flatMap((result) =>
		result.status === "rejected" ? [result.reason as unknown] : [],
	);
	if (failures.length === 1) throw failures[0];
	if (failures.length > 1) throw new AggregateError(failures, "test jobs failed");
	return new Map(
		[...completed]
			.sort(([left], [right]) => left - right)
			.map(([index, output]) => [inputs[index]!, output]),
	);
}
