import type {
	ViewBase,
	ViewMiddle,
	ViewDerived,
	ViewSibling,
	ViewUnrelated,
} from "maligator:ffi/views";

type Assert<Value extends true> = Value;
export type DerivedAcceptsBase = Assert<ViewDerived extends ViewBase ? true : false>;
export type DerivedAcceptsMiddle = Assert<ViewDerived extends ViewMiddle ? true : false>;
export type BaseCannotDowncast = Assert<ViewBase extends ViewDerived ? false : true>;
export type SiblingsRemainDistinct = Assert<
	ViewDerived extends ViewSibling ? false : true
>;
export type UnrelatedRemainDistinct = Assert<
	ViewUnrelated extends ViewBase ? false : true
>;
