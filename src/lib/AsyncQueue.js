/**
 * A queue which has an asynchronous dequeue call.
 */
export class AsyncQueue {
  /**
   * The internal queue of items
   * @type {Array}
   */
  #queue = []

  /**
   * A promise that will be resolved while the queue contains one or more items.
   * Otherwise it will remain unresolved until an item is enqueued.
   * @type {Promise<void>}
   */
  #dequeuePromise

  /**
   * A function that will resolve the current dequeue promise. If the promise
   * has already been resolved then calling this will do nothing.
   * @type {Function}
   */
  #resolveDequeuePromise

  /**
   * A promise that resolves the moment this queue is closed
   */
  #closedPromise

  /**
   * A function that, when called, will resolve this instance's "closed promise"
   */
  #resolveClosedPromise

  /**
   * Indicates whether or not this queue is closed
   * @type {boolean}
   */
  #isClosed = false

  /**
   * Creates a new asynchronous queue instance.
   * @param {Array} [values] The values with which to initiate the queue.
   */
  constructor (values) {
    // Create the dequeue promise
    this._createDequeuePromise()

    // Initialise the closed promise and its accompanying resolve function
    this.#closedPromise = new Promise(resolve => {
      this.#resolveClosedPromise = resolve
    })

    // If initial values have been provided then add them to the queue and
    // resolve the dequeue promise. The promise must be resolved right now
    // because values are available to be dequeued.
    if (Array.isArray(values)) {
      this.#queue.push(...values)
      this.#resolveDequeuePromise()
    }
  }

  /**
   * Creates a new dequeue promise and resolve function.
   * @private
   */
  _createDequeuePromise () {
    this.#dequeuePromise = new Promise(resolve => {
      this.#resolveDequeuePromise = resolve
    })
  }

  /**
   * Pops the next item from the queue.
   *
   * If the queue is empty then this will wait until a new item is added to the
   * queue and then pops it.
   *
   * If the queue is closed while this function is waiting to dequeue then this
   * will throw an error.
   * @returns {Promise}
   * @throws {Error} Throws an error when the queue was closed while this
   * function is waiting to dequeue.
   */
  async dequeue () {
    // If this queue is closed then this promise will ensure that an error is
    // thrown if the user tries to dequeue another value.
    const closePromise = this.#closedPromise
      .then(() => { throw new Error('Cannot dequeue when queue is closed') })

    // We race the close and dequeue promises against each other. If this queue
    // gets closed while we wait for a value to be dequeued then the close
    // promise above will throw an error.
    await Promise.race([closePromise, this.#dequeuePromise])

    // If the current queue only contains 1 item then set the dequeue promise
    // again, because the queue will be empty after the last value has been
    // popped.
    if (this.#queue.length <= 1) this._createDequeuePromise()

    // Return the value from the end of the queue
    return this.#queue.pop()
  }

  /**
   * Adds an item to the queue.
   * @param {*} item
   * @throws {Error} Throws an error when the queue is closed.
   */
  enqueue (item) {
    // If this queue is closed then throw an error immediately
    if (this.#isClosed) throw new Error('Cannot enqueue when queue is closed')

    this.#queue.unshift(item)
    this.#resolveDequeuePromise()
  }

  /**
   * Closes this queue so that no additional items can be added or removed.
   * This operation cannot be undone.
   */
  close () {
    // Mark the queue as closed (used by the `enqueue` method)
    this.#isClosed = true

    // Resolve the closed promise (used by the `dequeue` and
    // `[Symbol.asyncIterator]` methods)
    this.#resolveClosedPromise()

    // Clear the current queue. This frees up resources.
    this.#queue.splice(0, this.#queue.length)
  }

  /**
   * This function allows the queue to be used as an async iterator. Therefore
   * an instance of this class can be used in a `for await of` loop.
   * @returns {AsyncIterator}
   */
  [Symbol.asyncIterator] () {
    return {
      next: () => {
        const valuePromise = this.dequeue()
          .then(value => ({ value, done: false }))

        const closePromise = this.#closedPromise
          .then(() => ({ done: true }))

        // We race the promises here. If the queue is closed before the next
        // value is enqueued then this iterator will close.
        return Promise.race([valuePromise, closePromise])
      }
    }
  }
}
