/* global describe, before, it */

const SteamCmd = require('./class-implementation')
const {expect} = require('chai')
const fs = require('fs')

describe('SteamCmd', () => {
  let steam

  before(() => {
    steam = new SteamCmd()
  })

  describe('#downloadIfNeeded()', () => {
    it('should download the steamCMD file for this OS', async () => {
      await steam.downloadIfNeeded()

      expect(fs.accessSync(steam.exePath, fs.constants.X_OK)).to.not.throw()
    })
  })
})
