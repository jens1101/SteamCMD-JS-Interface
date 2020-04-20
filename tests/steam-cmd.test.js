import { SteamCmd } from '../dist/steam-cmd.cjs'

let steamCmd

global.beforeAll(async () => {
  steamCmd = await SteamCmd.init()
})

global.test('Can login anonymously', async () => {
  await steamCmd.login('anonymous')
})

global.describe('Test supported platforms', () => {
  let originalPlatformDescriptor

  global.beforeAll(() => {
    // Get the original property descriptor for `process.platform`
    originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process,
      'platform')
  })

  global.afterAll(() => {
    // Restore `process.platform` to its original value
    Object.defineProperty(process, 'platform', originalPlatformDescriptor)
  })

  global.test('Initializes on all supported platforms', async () => {
    const platforms = ['win32', 'darwin', 'linux']

    for (const platform of platforms) {
      Object.defineProperty(process, 'platform', { value: platform })
      await SteamCmd.init()
    }
  }, 15000)
})
