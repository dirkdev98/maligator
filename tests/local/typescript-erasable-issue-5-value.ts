export type Value = {
	readonly label: string;
};

export const value: Value = {
	label: "compact",
};

export default value;

export const ok = <const ValueType>(value: ValueType) => ({ value });
