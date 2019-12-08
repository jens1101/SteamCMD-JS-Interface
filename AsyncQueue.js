/**
 * A queue which has an asynchronous dequeue call.
 */
class AsyncQueue {
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
   * Creates a new asynchronous queue instance.
   * @param {Array} [values] The values with which to initiate the queue.
   */
  constructor (values) {
    // Create the dequeue promise
    this._createDequeuePromise()

    // If initial values have been provided then add them to the queue and
    // resolve the dequeue promise.
    //
    // The promise must be resolved right now because values are available.
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
   * Pops the next item from the queue. If the queue is empty then this will
   * wait until a new item is added to the queue and then pops it.
   * @returns {Promise}
   */
  async dequeue () {
    await this.#dequeuePromise
    if (this.#queue.length <= 1) this._createDequeuePromise()
    return this.#queue.pop()
  }

  /**
   * Adds an item to the queue.
   * @param {*} item
   */
  enqueue (item) {
    this.#queue.unshift(item)
    this.#resolveDequeuePromise()
  }
}

exports.AsyncQueue = AsyncQueue
