use core::alloc::{GlobalAlloc, Layout};
use core::ffi::c_void;
use core::fmt::{self, Write};
use core::panic::PanicInfo;
use core::ptr;

struct NativeAllocator;

const MALLOC_ALIGNMENT: usize = core::mem::align_of::<libc::max_align_t>();

fn naturally_aligned(layout: Layout) -> bool {
    layout.align() <= MALLOC_ALIGNMENT && layout.align() <= layout.size()
}

unsafe impl GlobalAlloc for NativeAllocator {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if naturally_aligned(layout) {
            return unsafe { libc::malloc(layout.size()).cast() };
        }
        let mut result = ptr::null_mut();
        if unsafe { libc::posix_memalign(&mut result, layout.align(), layout.size()) } == 0 {
            result.cast()
        } else {
            ptr::null_mut()
        }
    }

    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if naturally_aligned(layout) {
            return unsafe { libc::calloc(1, layout.size()).cast() };
        }
        let result = unsafe { self.alloc(layout) };
        if !result.is_null() {
            unsafe { result.write_bytes(0, layout.size()) };
        }
        result
    }

    unsafe fn dealloc(&self, block: *mut u8, _layout: Layout) {
        unsafe { libc::free(block.cast()) };
    }

    unsafe fn realloc(&self, block: *mut u8, layout: Layout, size: usize) -> *mut u8 {
        if naturally_aligned(layout) && layout.align() <= size {
            return unsafe { libc::realloc(block.cast(), size).cast() };
        }
        let replacement = unsafe { self.alloc(Layout::from_size_align_unchecked(size, layout.align())) };
        if !replacement.is_null() {
            unsafe {
                ptr::copy_nonoverlapping(block, replacement, layout.size().min(size));
                self.dealloc(block, layout);
            }
        }
        replacement
    }
}

#[global_allocator]
static ALLOCATOR: NativeAllocator = NativeAllocator;

struct Stderr;

impl Write for Stderr {
    fn write_str(&mut self, text: &str) -> fmt::Result {
        let result = unsafe { libc::write(libc::STDERR_FILENO, text.as_ptr().cast::<c_void>(), text.len()) };
        if result == text.len() as isize {
            Ok(())
        } else {
            Err(fmt::Error)
        }
    }
}

#[panic_handler]
fn panic(info: &PanicInfo<'_>) -> ! {
    let _ = writeln!(Stderr, "Maligator: {info}");
    unsafe { libc::abort() }
}

// Shipped core/alloc objects can reference a personality even in an abort build.
// A foreign exception crossing this C ABI must terminate the process.
#[no_mangle]
pub extern "C" fn rust_eh_personality(
    _version: libc::c_int,
    _actions: libc::c_int,
    _exception_class: u64,
    _exception: *mut c_void,
    _context: *mut c_void,
) -> libc::c_int {
    unsafe { libc::abort() }
}
