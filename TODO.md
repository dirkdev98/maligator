# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point
once we compile and run most JS.

## Property Storage Layer

- [ ] Implement `mal_property_lookup(...)`
- [ ] Implement `mal_property_define(...)`
- [ ] Implement `mal_property_set_value(...)`
- [ ] Implement `mal_property_write_entry(...)`
- [ ] Implement `mal_property_entry_key(...)`
- [ ] Implement `mal_property_entry_desc(...)`

## Ordinary Object Operations

- [ ] Implement `mal_object_properties(...)`
- [ ] Implement `mal_object_is_extensible(...)`
- [ ] Implement `mal_object_set_extensible(...)`
- [ ] Implement `mal_object_get_prototype(...)`
- [ ] Implement `mal_object_set_prototype(...)`
- [ ] Implement `mal_object_get_own(...)`
- [ ] Implement `mal_object_resolve_property(...)`
- [ ] Implement `mal_object_define_own(...)`
- [ ] Implement `mal_object_delete_own(...)`
- [ ] Implement `mal_object_set(...)`

## Function Objects

- [ ] Implement `mal_function_object_init(...)`
- [ ] Implement `mal_function_object_new(...)`
- [ ] Implement `mal_function_object_function_index(...)`
- [ ] Implement `mal_native_function_object_init(...)`
- [ ] Implement `mal_native_function_object_new(...)`
- [ ] Implement `mal_native_function_object_name(...)`
- [ ] Implement `mal_native_function_object_callback(...)`

## Array Objects

- [ ] Implement `mal_array_object_init(...)`
- [ ] Implement `mal_array_object_new(...)`
- [ ] Implement `mal_array_object_length(...)`
- [ ] Implement `mal_array_object_set_length(...)`

## Property Iteration

- [ ] Implement `mal_property_iter_init(...)`
- [ ] Implement `mal_property_iter_next(...)`

## High level

- [ ] Create support a call frame + stack em.
- [ ] Implement create_function
- [ ] Decide on value_ops vs vm_op vs whatever?
- [ ] Debug location tables
- [ ] Arguments object
- [ ] For-loops

### Resources / reading list

- https://zef-lang.dev/implementation
- https://wren.io/performance.html
- https://benhoyt.com/writings/hash-table-in-c/
- https://github.com/tidwall/hashmap.c

### You never know ideas

- Erlang/OTP style message passing & cooperative scheduler.
- GUI work
- Deploying to AWS Lambda
- Compile to bare-metal maybe?
