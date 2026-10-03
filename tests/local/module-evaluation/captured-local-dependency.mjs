export function makeLookup(values) {
	const entries = new Map(values.map((value) => [value, value * 2]));
	const lookup = (value) => entries.get(value);
	for (const value of values) {
		if (!entries.has(value))
			throw new Error("captured entries disappeared during initialization");
	}
	return lookup;
}
