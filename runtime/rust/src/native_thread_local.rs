use alloc::boxed::Box;
use core::ffi::c_void;
use core::sync::atomic::{AtomicUsize, Ordering};

const UNINITIALIZED: usize = usize::MAX;

pub(crate) struct ThreadLocal<T> {
    key: AtomicUsize,
    init: fn() -> T,
}

impl<T: 'static> ThreadLocal<T> {
    pub(crate) const fn new(init: fn() -> T) -> Self {
        Self {
            key: AtomicUsize::new(UNINITIALIZED),
            init,
        }
    }

    #[cold]
    fn init_key(&self) -> usize {
        unsafe extern "C" fn destroy<T>(ptr: *mut c_void) {
            unsafe { drop(Box::from_raw(ptr.cast::<T>())) };
        }

        let mut key = 0;
        if unsafe { libc::pthread_key_create(&mut key, Some(destroy::<T>)) } != 0 {
            panic!("could not create Rust thread-local key");
        }
        match self.key.compare_exchange(
            UNINITIALIZED,
            key as usize,
            Ordering::AcqRel,
            Ordering::Acquire,
        ) {
            Ok(_) => key as usize,
            Err(existing) => {
                unsafe { libc::pthread_key_delete(key) };
                existing
            }
        }
    }

    #[cold]
    fn init_value(&self, key: libc::pthread_key_t) -> *mut T {
        let value = Box::into_raw(Box::new((self.init)()));
        if unsafe { libc::pthread_setspecific(key, value.cast()) } != 0 {
            unsafe { drop(Box::from_raw(value)) };
            panic!("could not store Rust thread-local value");
        }
        value
    }

    pub(crate) fn with<R>(&self, call: impl FnOnce(&T) -> R) -> R {
        let mut key = self.key.load(Ordering::Acquire);
        if key == UNINITIALIZED {
            key = self.init_key();
        }
        let key = key as libc::pthread_key_t;
        let mut value = unsafe { libc::pthread_getspecific(key) }.cast::<T>();
        if value.is_null() {
            value = self.init_value(key);
        }
        call(unsafe { &*value })
    }
}

macro_rules! tls_slot {
    ($($(#[$attribute:meta])* static $name:ident: $ty:ty = const $init:block;)*) => {
        $(
            $(#[$attribute])*
            static $name: $crate::native_thread_local::ThreadLocal<$ty> =
                $crate::native_thread_local::ThreadLocal::new(|| $init);
        )*
    };
}

pub(crate) use tls_slot;
