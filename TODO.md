# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point
once we compile and run most JS.

## Low level

## High level

- [ ] Bundler things: modules, scripts, strict-mode, CommonJS, etc.
- [ ] Debug location tables and error stack traces
- [ ] More performance work.
- [ ] RegExp objects
- [ ] Temporal global on temporal_rs (evaluate the temporal_capi C bindings)
- [ ] Intl locale data: let consumers choose the bundled locale set. We ship
      ICU4X `compiled_data` (all locales) for now; move to a curated /
      configurable `icu4x-datagen` baked build so embedders pick their locales.
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
