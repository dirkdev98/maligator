export type Value = {
	readonly label: string;
};

export const value: Value = {
	label: "compact",
};

export default value;

export type Result<ErrorType, ValueType> =
	| { readonly ok: true; readonly value: ValueType }
	| { readonly error: ErrorType; readonly ok: false };

export const ok = <const ValueType>(value: ValueType): Result<never, ValueType> => ({
	ok: true,
	value,
});
export const err = <const ErrorType>(error: ErrorType) => ({ error });
