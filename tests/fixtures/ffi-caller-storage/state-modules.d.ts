declare module "maligator:ffi/state" {
	interface State {
		[Symbol.dispose](): void;
	}
	interface Copy extends State {
		readonly value: number;
	}
	export function CallerState(): State;
	export function caller_state_init(state: State, value: number): number;
	export function caller_state_read(state: State): number;
	export function caller_state_aligned(state: State): number;
	export function caller_state_same(state: State): State | null;
	export function caller_state_cleanup(state: State): void;
	export function caller_state_visit(
		state: State,
		visit: (state: State | null) => void,
	): void;
	export function caller_state_live(): number;
	export function caller_copy(value: number): Copy;
	export function caller_copy_aligned(state: Copy): number;
	export function regex_t(): State;
	export function regcomp(state: State, pattern: string, flags: number): number;
	export function regexec(state: State, text: string, flags: number): number;
	export function regfree(state: State): void;
	export const REG_EXTENDED: number;
	export const REG_NOSUB: number;
	export const REG_NOMATCH: number;
}
