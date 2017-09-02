/* global describe, before, beforeEach, after, it */

const {expect} = require('chai')
const fs = require('fs-extra')
const SteamCmd = require('./class-implementation')

describe('SteamCmd platform-dependant functionality', () => {
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

      describe('#downloadSteamCmd()', () => {
        it('should download the steamCMD file for this OS', async function () {
          // Set the timeout to zero, because this can take a while.
          this.timeout(0)
          await this.steam.downloadSteamCmd()

          return fs.access(this.steam.exePath, fs.constants.X_OK)
        })

        it('should not download the steamCMD file if it already exists', async function () {
          // TODO I need a watcher here to make sure that the _download function
          // is not called at all!
          await this.steam.downloadSteamCmd()

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

describe('Instance functions', () => {
  describe('construction', () => {
    it('you should be able to overwrite all default options', function () {
      const options = {}
      for (const key of Object.keys(SteamCmd.DEFAULT_OPTIONS)) {
        options[key] = Math.random()
      }

      const steam = new SteamCmd(options)
      expect(steam._options).to.deep.equal(options)
    })
  })

  describe('#setOptions', () => {
    it('you should be able to overwrite all default options', function () {
      const steam = new SteamCmd()

      for (const key of Object.keys(SteamCmd.DEFAULT_OPTIONS)) {
        const val = Math.random()
        steam.setOptions({[key]: val})

        expect(steam._options[key]).to.equal(val)
      }
    })
  })

  describe('#prep', () => {
    beforeEach(function () {
      this.steam = new SteamCmd()
    })

    it('should successfully download StremCMD and use it', async function () {
      this.timeout(0)

      await fs.remove(this.steam._options.binDir)
      return this.steam.prep()
    })
  })

  describe('#_touch()', () => {
    beforeEach(function () {
      this.steam = new SteamCmd()
    })

    it('should succeed when SteamCMD is installed', async function () {
      this.timeout(0)

      await this.steam.downloadSteamCmd()

      // Note: this can take a very long time, especially if the binaries had to
      // be freshly downloaded. This is because SteamCMD will first do an update
      // before running the command.
      return this.steam._touch()
    })

    it('should fail when SteamCMD is not installed', async function () {
      await fs.remove(this.steam._options.binDir)

      return this.steam._touch()
        .then(() => {
          // The test fails when the function call resolves, because SteamCMD
          // shouldn't work when the exe is deleted.
          throw new Error("StremCMD can't possibly work without the binaries")
        }, () => {
          // The test passes when the function call rejects.
        })
    })
  })

  // TODO add tests for getLoginStr

  // TODO add tests for run

  // TODO add tests for updateApp
  // This requires:
  // - The default download respects your current platform and bitness
  // - Fails in some way when you try to download an app that you don't have
  // access to.
  // - Fails in some way when you try to download an app that is not available
  // on your chosen platform and bitness
  // - Fails in some way when you try to download an app that doesn't exist.
  // - The downloader respects your current username, pass, steam guard code,
  // platform, and bitness
  // - You can kill the current SteamCMD process.
})
