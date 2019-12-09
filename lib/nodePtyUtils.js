const { AsyncQueue } = require('./AsyncQueue')
const stripAnsi = require('strip-ansi')

module.exports = {
  getPtyDataIterator,
  getPtyExitPromise
}

/**
 * Returns all the "data" events as a string for the given pseudo terminal
 * instance.
 * @param {IPty} pty The pseudo terminal instance
 * @param {boolean} [raw=false] If true then the output of the Steam CMD
 * process is returned as is. If false then line endings will be normalised to
 * `\n`, all `\r` will be stripped, and all ANSI escape characters will be
 * stripped.
 * @returns {AsyncIterableIterator<string>}
 */
async function * getPtyDataIterator (pty, raw = false) {
  /**
   * A queue of all the output that has been returned by the pseudo terminal
   * @type {AsyncQueue}
   */
  const asyncQueue = new AsyncQueue()

  // For each "data" event add the terminal output to the async queue.
  // noinspection JSUnresolvedFunction
  const { dispose: disposeDataListener } = pty.onData(outputLine => {
    if (raw) {
      asyncQueue.enqueue({ value: outputLine, done: false })
      return
    }

    const normalisedLine = outputLine
      .replace(/\r\n/g, '\n')
      .replace(/\r/, '')

    const line = `${stripAnsi(normalisedLine)}`
    asyncQueue.enqueue({ value: line, done: false })
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
 * @param {IPty} pty The pseudo terminal instance to monitor.
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
