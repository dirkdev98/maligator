# TODO

Our TODO list in order of implementation. Below the fold there is also a list of experiments I want to do at some point
once we compile and run most JS.

- [ ] Add support for some form of hash table
  - We don't care about memory for now
  - We need to support insert based iteration order
  - We need to support numerical keys, symbols and more.
  - We will use this as the backing store for any form of object. At some point we can optimize non-holey arrays.
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
