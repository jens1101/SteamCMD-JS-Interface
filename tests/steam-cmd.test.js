/**
 * @jest-environment node
 */

import { rm } from 'fs/promises'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { SteamCmd } from '../src/SteamCmd'

/**
 * The Steam CMD instance used throughout these tests
 * @type {SteamCmd}
 */
let steamCmd

/**
 * Calculates how long (in milliseconds) it will take to download a file using
 * the current internet speed.
 * @param {number} downloadSize The file size in bytes
 * @return {number} The number of milliseconds it will take to download the file
 */
function calculateDownloadTimeout (downloadSize) {
  /** Download speed in bits per second */
  const DOWNLOAD_SPEED = 9_000_000
  const SAFETY_FACTOR = 3

  return downloadSize / (DOWNLOAD_SPEED / 8) * 1000 * SAFETY_FACTOR
}

global.beforeAll(
  async () => {
    const tempDir = join(dirname(fileURLToPath(import.meta.url)), '../temp')
    await rm(tempDir, { force: true, recursive: true })

    steamCmd = await SteamCmd.init({ enableDebugLogging: true })
  },
  // SteamCMD downloads about 20MB on first launch. Set the timeout accordingly.
  calculateDownloadTimeout(20_000_000)
)

global.test(
  'Can login anonymously',
  async () => {
    await steamCmd.login('anonymous')
  },
  20_000
)

global.test(
  'Can download/update apps',
  async () => {
    // Download the Source SDK Base 2013 Dedicated Server. This is the smallest
    // app I could find that may be downloaded anonymously.
    const download = steamCmd.updateApp(244310, {
      platformType: 'linux',
      platformBitness: 64,
      betaName: 'prerelease'
    })

    for await (const { state, progressPercent } of download) {
      console.log(`Update state: ${state} ${progressPercent.toFixed(2)}%`)
    }
  },
  // The download uses approximately 680MB of data. Set the timeout accordingly.
  calculateDownloadTimeout(680_000_000)
)
