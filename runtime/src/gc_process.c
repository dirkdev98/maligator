#include "gc_process.h"

#include <stdatomic.h>
#include <stdlib.h>
#include "gc.h"
#include "gc_cpu_linux.h"
#if !defined(__wasi__)
#include <pthread.h>
#include <unistd.h>
#if defined(__linux__)
#include <sched.h>
#endif
#endif

struct MalGcProcessParticipant {
    struct MalGcProcessParticipant *next;
    MalGcPollTarget *poll;
    bool busy;
    bool pressure;
    void (*wake)(void *);
    void *wake_data;
};

static MalGcProcessParticipant *g_participants;
static _Atomic usize g_bytes;
static usize g_budget;
static usize g_next_pressure;
static usize g_busy;
static usize g_helpers;
static usize g_cpus;
#if !defined(__wasi__)
static pthread_mutex_t g_mutex = PTHREAD_MUTEX_INITIALIZER;
#define LOCK() pthread_mutex_lock(&g_mutex)
#define UNLOCK() pthread_mutex_unlock(&g_mutex)
#else
#define LOCK() ((void) 0)
#define UNLOCK() ((void) 0)
#endif

static void configure(void) {
    if (g_budget != 0) return;
    g_budget = (usize) 256 << 20;
    const char *option = getenv("MAL_GC_PROCESS_BUDGET_BYTES");
    if (option != nullptr && option[0] != '\0') {
        char *end;
        unsigned long long value = strtoull(option, &end, 10);
        if (*end == '\0' && value >= (1u << 20) && value <= SIZE_MAX) g_budget = (usize) value;
    }
    g_next_pressure = g_budget;
    g_cpus = 1;
#if !defined(__wasi__)
    long online = sysconf(_SC_NPROCESSORS_ONLN);
    if (online > 0) g_cpus = (usize) online;
#if defined(__linux__)
    cpu_set_t affinity;
    if (sched_getaffinity(0, sizeof(affinity), &affinity) == 0) {
        usize available = (usize) CPU_COUNT(&affinity);
        if (available > 0 && available < g_cpus) g_cpus = available;
    }
    g_cpus = mal_gc_linux_cpu_quota(g_cpus).cpus;
#endif
#endif
}

MalGcProcessParticipant *mal_gc_process_register(MalGcPollTarget *poll) {
    MalGcProcessParticipant *participant = calloc(1, sizeof(*participant));
    if (participant == nullptr) abort();
    participant->poll = poll;
    participant->busy = true;
    LOCK();
    configure();
    participant->next = g_participants;
    g_participants = participant;
    g_busy++;
    UNLOCK();
    return participant;
}

void mal_gc_process_unregister(MalGcProcessParticipant *participant) {
    if (participant == nullptr) return;
    LOCK();
    for (MalGcProcessParticipant **link = &g_participants; *link != nullptr; link = &(*link)->next) {
        if (*link == participant) {
            *link = participant->next;
            if (participant->busy) g_busy--;
            break;
        }
    }
    UNLOCK();
    free(participant);
}

void mal_gc_process_set_busy(MalGcProcessParticipant *participant, bool busy) {
    if (participant == nullptr) return;
    LOCK();
    if (participant->busy != busy) {
        participant->busy = busy;
        if (busy) g_busy++;
        else g_busy--;
    }
    UNLOCK();
}

bool mal_gc_process_take_pressure(MalGcProcessParticipant *participant) {
    if (participant == nullptr) return false;
    LOCK();
    bool pressure = participant->pressure;
    participant->pressure = false;
    UNLOCK();
    return pressure;
}

void mal_gc_process_set_waker(MalGcProcessParticipant *participant, void (*wake)(void *), void *data) {
    if (participant == nullptr) return;
    LOCK();
    participant->wake = wake;
    participant->wake_data = data;
    UNLOCK();
}

void mal_gc_process_charge(usize bytes) {
    if (bytes == 0) return;
    usize previous = atomic_fetch_add_explicit(&g_bytes, bytes, memory_order_relaxed);
    if (previous > SIZE_MAX - bytes) abort();
    LOCK();
    configure();
    usize total = atomic_load_explicit(&g_bytes, memory_order_relaxed);
    if (total >= g_next_pressure) {
        usize step = g_budget / 16;
        g_next_pressure = total > SIZE_MAX - step ? SIZE_MAX : total + step;
        // Registry ownership protects each mutator's TLS poll target through this request.
        for (MalGcProcessParticipant *p = g_participants; p != nullptr; p = p->next) {
            p->pressure = true;
            mal_gc_request_safepoint(p->poll);
            if (p->wake != nullptr) p->wake(p->wake_data);
        }
    }
    UNLOCK();
}

void mal_gc_process_release(usize bytes) {
    if (bytes == 0) return;
    usize previous = atomic_fetch_sub_explicit(&g_bytes, bytes, memory_order_relaxed);
    if (previous < bytes) abort();
    LOCK();
    usize current = atomic_load_explicit(&g_bytes, memory_order_relaxed);
    if (current < g_budget - g_budget / 4) {
        g_next_pressure = g_budget;
    } else {
        usize step = g_budget / 16;
        usize next = current > SIZE_MAX - step ? SIZE_MAX : current + step;
        if (next < g_budget) next = g_budget;
        // A released peak must not suppress pressure during later, smaller native growth.
        if (next < g_next_pressure) g_next_pressure = next;
    }
    UNLOCK();
}

usize mal_gc_process_bytes(void) {
    return atomic_load_explicit(&g_bytes, memory_order_relaxed);
}

usize mal_gc_process_budget(void) {
    LOCK();
    configure();
    usize budget = g_budget;
    UNLOCK();
    return budget;
}

usize mal_gc_process_cpu_capacity(void) {
    LOCK();
    configure();
    usize cpus = g_cpus;
    UNLOCK();
    return cpus;
}

bool mal_gc_process_helper_acquire(void) {
    LOCK();
    configure();
    bool granted = g_helpers < 2 && g_busy < g_cpus && g_helpers < g_cpus - g_busy;
    if (granted) g_helpers++;
    UNLOCK();
    return granted;
}

void mal_gc_process_helper_release(void) {
    LOCK();
    if (g_helpers == 0) abort();
    g_helpers--;
    UNLOCK();
}
