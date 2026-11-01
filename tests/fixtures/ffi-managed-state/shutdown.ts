import { ManagedState, managed_copy_slow_async } from "maligator:ffi/managed";

const state = ManagedState();
state.next_in = new Uint8Array([41, 43]);
state.next_out = new Uint8Array(2);
void managed_copy_slow_async(state);
throw new Error("managed shutdown requested");
