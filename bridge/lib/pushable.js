// Minimal async pushable iterable, used as the Agent SDK streaming input.

function createPushable() {
  const queue = [];
  let resolveNext = null;
  let done = false;

  return {
    push(value) {
      if (done) return;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value, done: false });
      } else {
        queue.push(value);
      }
    },
    end() {
      done = true;
      if (resolveNext) {
        const r = resolveNext;
        resolveNext = null;
        r({ value: undefined, done: true });
      }
    },
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (done) return Promise.resolve({ value: undefined, done: true });
          return new Promise((resolve) => { resolveNext = resolve; });
        },
        return() {
          done = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      };
    },
  };
}

module.exports = { createPushable };
