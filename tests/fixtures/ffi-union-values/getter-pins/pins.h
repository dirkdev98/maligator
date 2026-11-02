typedef struct Owner Owner;
typedef union Choice { struct { int amount; } point; int items[1]; } Choice;
Owner *pins_new(void);
void pins_free(Owner *owner);
int pins_value(Owner *owner, Choice input);
int pins_array(Owner *owner, Choice input);
int pins_freed(void);
