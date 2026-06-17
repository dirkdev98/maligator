# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point
once we compile and run most JS.

## High level

- [ ] More performance work.
- [ ] RegExp objects
- [ ] Temporal global on temporal_rs (evaluate the temporal_capi C bindings)
- [ ] Don't include icu4x data when not used / split locales. We currently create 11mb binaries.
- [ ] Replace Meriyah with a type-stripping supporting parser
- [ ] GC, malloc optimizations, compiled lifetimes, struct layouts
- [ ] Eval & function constructor
- [ ] Decide on value_ops vs vm_op vs whatever?

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
