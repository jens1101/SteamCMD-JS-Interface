/* global describe, before, after, it */

const {expect} = require('chai')
const fs = require('fs-extra')
const SteamCmd = require('./class-implementation')

describe.skip('SteamCmd platform-dependant functionality', () => {
  /**
   * All the platforms to be tested
   * @type {string[]}
   */
  const platforms = ['win32', 'darwin', 'linux']

  for (const platform of platforms) {
    describe(`for ${platform}`, () => {
      before(async function () {
        // I need to re-define `process.platform` in order to test the various
        // platform-dependent functionality. I keep the original value so that
        // can be restored later on.
        this.originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
        Object.defineProperty(process, 'platform', {
          value: platform
        })

        this.steam = new SteamCmd()
        await fs.remove(this.steam._options.binDir)
      })

      after(async function () {
        // Restore the original value of `process.platform`
        Object.defineProperty(process, 'platform', this.originalPlatform)

        // Clean-up after ourselves
        await fs.remove(this.steam._options.binDir)
      })

      describe('#download()', () => {
        it('should download the steamCMD file for this OS', async function () {
          // Set the timeout to zero, because this can take a while.
          this.timeout(0)
          await this.steam.download()

          return fs.access(this.steam.exePath, fs.constants.X_OK)
        })

        it('should not download the steamCMD file if it already exists', async function () {
          // TODO I need a watcher here to make sure that the _download function
          // is not called at all!
          await this.steam.download()

          return fs.access(this.steam.exePath, fs.constants.X_OK)
        })
      })
    })
  }

  describe('for an unknown platform', () => {
    before(function () {
      // I need to re-define `process.platform` in order to test the various
      // platform-dependent functionality. I keep the original value so that
      // can be restored later on.
      this.originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
      Object.defineProperty(process, 'platform', {
        value: 'foobar'
      })
    })

    after(function () {
      // Restore the original value of `process.platform`
      Object.defineProperty(process, 'platform', this.originalPlatform)
    })

    it(`should throw an error when constructing`, function () {
      expect(() => new SteamCmd()).to.throw()
    })
  })
})

describe('Static functions', () => {
  /**
  * Tests whether or not a promise finishes within the defined timeout.
  * @param {Function} promiseFn A function that returns a promise. This will
  * be the promise that this function will measure.
  * @param {number} timeout The timeout within which the promise must finish
  * @param {number} [marginOfError=0.05] The ratio of the original timeout
  * that will be given as an acceptible marin of error. The default is
  * 0.05 = 5%.
  */
  async function testPromiseTimeout (promiseFn, timeout, marginOfError = 0.05) {
    /**
    * The actual margin of error in ms, based on the given timeout. This has
    * min value of 3ms, because promises don't tend to be any more accurate
    * than that; especially for very short-running promises.
    * @type {number}
    */
    const actualMargin = Math.max(timeout * marginOfError, 3)
    const startTime = process.hrtime()

    await promiseFn()

    const endTime = process.hrtime()
    const elapsedTime = ((endTime[0] * 1000 + endTime[1] / 1000000) -
    (startTime[0] * 1000 + startTime[1] / 1000000))
    const hasPassed = elapsedTime < timeout + actualMargin &&
    elapsedTime > timeout - actualMargin

    if (!hasPassed) {
      throw new Error(`Promise finished in ${elapsedTime}ms, insted of ${timeout}ms`)
    }
  }

  describe('#_timeout()', () => {
    it('should resolve after the given timeout (in ms)', function () {
      return Promise.all([
        testPromiseTimeout(() => SteamCmd._timeout(5), 5),
        testPromiseTimeout(() => SteamCmd._timeout(200), 200),
        testPromiseTimeout(() => SteamCmd._timeout(1000), 1000)
      ])
    })
  })

  describe('#_promiseToRetry()', () => {
    it('should fail after retrying too many times', async function () {
      this.timeout(2500)

      const maxRetries = 4
      let retries = 0
      const retryDelay = 500
      const steam = new SteamCmd({retries: maxRetries, retryDelay})

      try {
        await steam._promiseToRetry(() => {
          retries++
          throw new Error('Test error')
        })

        return Promise.reject(new Error(`_promiseToRetry did not throw an error
          after ${maxRetries} retries`))
      } catch (ex) {
        if (retries < maxRetries) {
          throw new Error(`_promiseToRetry failed too early after ${retries}
            retries instead of ${maxRetries} retries`)
        } else if (retries > maxRetries) {
          throw new Error(`_promiseToRetry failed too late after ${retries}
            retries instead of ${maxRetries} retries`)
        }

        // If retries = maxRetries then this test passes
        return
      }
    })
  })
})
