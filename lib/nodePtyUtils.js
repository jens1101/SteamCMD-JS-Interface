const { AsyncQueue } = require('./AsyncQueue')

module.exports = {
  getPtyDataIterator,
  getPtyExitPromise
}

/**
 * Returns all the "data" events as a string for the given pseudo terminal
 * instance.
 * @param {IPty} pty The pseudo terminal instance
 * @returns {AsyncIterableIterator<string>}
 */
async function * getPtyDataIterator (pty) {
  /**
   * A queue of all the output that has been returned by the pseudo terminal
   * @type {AsyncQueue}
   */
  const asyncQueue = new AsyncQueue()

  // For each "data" event add the terminal output to the async queue.
  // noinspection JSUnresolvedFunction
  const { dispose: disposeDataListener } = pty.onData(data => {
    asyncQueue.enqueue({ value: data, done: false })
  })

  // Once the "exit" event has been fired then dispose of all the listeners and
  // enqueue the "done" signal in the async queue,
  // noinspection JSUnresolvedFunction
  const { dispose: disposeExitListener } = pty.onExit(() => {
    asyncQueue.enqueue({ done: true })
    disposeExitListener()
    disposeDataListener()
  })

  /**
   * The asynchronous iterator object that iterates through the async queue of
   * output.
   * @type {AsyncIterable}
   */
  const iterator = {
    [Symbol.asyncIterator] () {
      return {
        next () {
          return asyncQueue.dequeue()
        }
      }
    }
  }

  // This loops through the iterator above and yields each item. This isn't
  // strictly necessary, however this is done so that the async generator
  // syntax is preserved.
  for await (const line of iterator) {
    yield line
  }
}

/**
 * Returns a promise that will resolve once the pseudo terminal's "exit" event
 * is fired.
 * @param {IPty} pty
 * @returns {Promise<number>} A promise that resolves into the exit code of the
 * process.
 */
async function getPtyExitPromise (pty) {
  return new Promise(resolve => {
    // noinspection JSUnresolvedFunction
    const { dispose: disposeExitListener } = pty.onExit(event => {
      resolve(event.exitCode)
      disposeExitListener()
    })
  })
}
