export function constrainVitestMaxWorkers(
	arguments_: ReadonlyArray<string>,
	workers: number,
): Array<string> {
	const constrained: Array<string> = [];
	for (let index = 0; index < arguments_.length; index++) {
		const argument = arguments_[index]!;
		if (argument === "--maxWorkers") {
			if (arguments_[index + 1] === undefined) {
				throw new Error("--maxWorkers requires a value");
			}
			index++;
			continue;
		}
		if (argument.startsWith("--maxWorkers=")) continue;
		constrained.push(argument);
	}
	constrained.push(`--maxWorkers=${workers}`);
	return constrained;
}
