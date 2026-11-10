// Promise.race does not cancel its loser. Keep one folder watch across quiet
// timeouts, and cancel the fallback timer when a change arrives first.
export function folderPoll(watch, timer, dir, interval = 15000) {
  let pending = null;
  return async function wait() {
    if (!pending) {
      pending = watch(dir)
        .catch(() => new Promise((resolve) => timer.after(3000, resolve)))
        .finally(() => { pending = null; });
    }
    let timeout;
    try {
      await Promise.race([pending, new Promise((resolve) => {
        timeout = timer.after(interval, resolve);
      })]);
    } finally {
      timeout?.cancel();
    }
  };
}
