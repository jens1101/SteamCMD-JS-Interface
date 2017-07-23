const SteamCmd = require('./class-implementation')

const testSteam = new SteamCmd()
const ioStream = testSteam.run()

ioStream.pipe(process.stdout)
ioStream.pipe(process.stdin)
