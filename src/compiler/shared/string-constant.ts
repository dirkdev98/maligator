export function stringConstantEquals(
	units: ReadonlyArray<number> | undefined,
	value: string,
): boolean {
	return (
		units?.length === value.length &&
		units.every((unit, index) => unit === value.charCodeAt(index))
	);
}
