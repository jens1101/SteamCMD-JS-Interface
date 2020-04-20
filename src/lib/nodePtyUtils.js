import { AsyncQueue } from './AsyncQueue'
import stripAnsi from 'strip-ansi'

/**
 * Returns all the "data" events as a string for the given pseudo terminal
 * instance.
 * @param {IPty} pty The pseudo terminal instance
 * @param {boolean} [raw=false] If true then the output of the Steam CMD
 * process is returned as is. If false then line endings will be normalised to
 * `\n`, all `\r` will be stripped, all ANSI escape characters will be
 * stripped, and all white spaces at the start and end of each output line will
 * be trimmed.
 * @yields {string} The line of output from the pseudo terminal
 */
export async function * getPtyDataIterator (pty, raw = false) {
  /**
   * A queue of all the output that has been returned by the pseudo terminal
   * @type {AsyncQueue}
   */
  const asyncQueue = new AsyncQueue()

  // For each "data" event add the terminal output to the async queue.
  // noinspection JSUnresolvedFunction
  const { dispose: disposeDataListener } = pty.onData(outputLine => {
    if (raw) {
      asyncQueue.enqueue(outputLine)
      return
    }

    const normalisedLine = outputLine
      .replace(/\r\n/g, '\n')
      .replace(/\r/, '')
      .trim()

    const line = `${stripAnsi(normalisedLine)}`
    asyncQueue.enqueue(line)
  })

  // Once the "exit" event has been fired then dispose of all the listeners and
  // enqueue the "done" signal in the async queue,
  // noinspection JSUnresolvedFunction
  const { dispose: disposeExitListener } = pty.onExit(() => {
    asyncQueue.close()
    disposeExitListener()
    disposeDataListener()
  })

  // Iterate over the async queue and yield each line.
  for await (const line of asyncQueue) {
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
export async function getPtyExitPromise (pty) {
  return new Promise(resolve => {
    // noinspection JSUnresolvedFunction
    const { dispose: disposeExitListener } = pty.onExit(event => {
      resolve(event.exitCode)
      disposeExitListener()
    })
  })
}
