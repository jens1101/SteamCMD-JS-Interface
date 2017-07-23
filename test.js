const SteamCmd = require('./class-implementation')

const testSteam = new SteamCmd()
const ioStream = testSteam.run()

ioStream.stdout.on('data', data => { console.log(data.toString()) })
process.stdin.pipe(ioStream.stdin)
