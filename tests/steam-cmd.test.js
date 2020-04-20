import { SteamCmd } from '../dist/steam-cmd.cjs'

let steamCmd

global.beforeAll(async () => {
  steamCmd = await SteamCmd.init({})
})

global.test('Can login anonymously', async () => {
  await steamCmd.login('anonymous')
})
