# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point
once we compile and run most JS.

## Low level

## High level

- [ ] Bundler things: modules, scripts, strict-mode, CommonJS, etc.
- [ ] Debug location tables and error stack traces
- [ ] More performance work.
- [ ] RegExp objects
- [ ] Date objects
- [ ] Replace Meriyah with a type-stripping supporting parser
- [ ] GC, malloc optimizations, compiled lifetimes
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
