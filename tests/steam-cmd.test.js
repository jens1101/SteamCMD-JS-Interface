/**
 * @jest-environment node
 */

import fs from 'fs'
import path from 'path'
import { SteamCmd } from '../dist/steam-cmd.cjs'

let steamCmd

global.beforeAll(async () => {
  const tempDir = path.join(__dirname, '../temp')
  await fs.promises.rmdir(tempDir, { recursive: true })

  steamCmd = await SteamCmd.init()
}, 600_000)

global.test('Can login anonymously', async () => {
  await steamCmd.login('anonymous')
})
