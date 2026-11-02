declare module "maligator:ffi/state" {
	interface State {
		[Symbol.dispose](): void;
	}
	interface Copy extends State {
		readonly value: number;
	}
	export function IncompleteState(): State;
	export function incomplete_state_layout(size: bigint, alignment: bigint): void;
	export function incomplete_state_default_layout(): void;
	export function incomplete_state_size_queries(): number;
	export function incomplete_state_alignment_queries(): number;
	export function incomplete_state_query_hook(callback: (() => void) | null): void;
	export function incomplete_state_init(state: State, value: number): number;
	export function incomplete_state_read(state: State): number;
	export function incomplete_state_cleanup(state: State): void;
	export function incomplete_state_aligned(state: State): number;
	export function incomplete_state_zero(state: State): number;
	export function incomplete_state_fill(state: State): void;
	export function incomplete_state_same(state: State): State | null;
	export function incomplete_state_base(state: State): State | null;
	export function incomplete_base_read(state: State): number;
	export function incompleteVisitAsync(
		state: State,
		callback: (state: State | null) => void,
	): Promise<void>;
	export function incomplete_state_live(): number;
	export function CallerState(): State;
	export function VariableState(length: bigint): State;
	export function WideState(length: bigint): State;
	export function variable_state_zero(state: State, count: bigint): number;
	export function variable_state_fill(state: State, count: bigint, seed: number): void;
	export function variable_state_sum(state: State): number;
	export function variableStateSumAsync(state: State): Promise<number>;
	export function variable_state_aligned(state: State): number;
	export function variable_state_same(state: State): State | null;
	export function variable_state_visit(
		state: State,
		callback: (state: State | null) => void,
	): void;
	export function variableStateVisitAsync(
		state: State,
		callback: (state: State | null) => void,
	): Promise<void>;
	export function wide_state_fill(state: State, count: bigint): void;
	export function wide_state_sum(state: State): bigint;
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
	export function caller_state_listen(
		state: State,
		listener: (event: number) => void,
	): void;
	export function caller_state_emit(state: State, event: number): void;
	export function caller_state_emit_thread(state: State, event: number): number;
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
