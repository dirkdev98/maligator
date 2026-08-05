// eslint-disable-next-line import-x/consistent-type-specifier-style -- native compact-strip acceptance fixture.
import { type Numbers } from "./types.ts";

export interface DescriptionInput<Values extends Numbers = Numbers> {
	readonly label: string;
	readonly values: Values;
}

export function describeValues(label: string, values: Numbers): string {
	return `${label}:${values.join(",")}:${values.map(double).join(",")}`;
}

export const selectValues = <Values extends Numbers>({
	values,
}: DescriptionInput<Values>): Values => values;

function double(value: number): number {
	return value * 2;
}
