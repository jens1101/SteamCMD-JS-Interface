const path = require('path')
// TODO use fs-extra instead.
const fs = require('fs')
const request = require('request')
const _ = require('lodash')
// TODO what does this even do? I would like to remove it because it hasn't been
// updated in 4 years!
const vdf = require('vdf')

// TODO also try to remove unzip, tar, and zlib. They haven't been updated in
// years and I'm sure that a native option exists

// const { spawn } = require('child_process')
const stream = require('stream')

// TODO use node-pty instead of child_process. This is apparantly a better option
// because it gives us the full output
const pty = require('node-pty')
const stripAnsi = require('strip-ansi')
const mkdirp = require('mkdirp')

// TODO use underscores for private functions and variables
module.exports = class SteamCmd {
  constructor (options) {
    this._defaultOptions = {
      asyncDelay: 3000,
      binDir: path.join(__dirname, 'steamcmd_bin', process.platform),
      retries: 3,
      retryDelay: 3000,
      installDir: path.join(__dirname, 'install_dir')
    }
    this._options = _.defaults({}, options, this._defaultOptions)
    this.steamcmdReady = false
    /**
     * Indicates who is currently logged in. An empty string means no has been
     * logged in yet.
     * @type {string}
     */
    this.loggedIn = ''

    // Some platform-dependent setup
    switch (process.platform) {
      case 'win32':
        this.platformVars = {
          url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
          extract: (resolve, reject) => {
            const {Extract} = require('unzip')

            mkdirp.sync(this._options.binDir)

            return new Extract({
              path: this._options.binDir
            }).on('finish', resolve).on('error', reject)
          },
          exeName: 'steamcmd.exe',
          shellName: 'powershell.exe',
          echoExitCode: 'echo $lastexitcode'
        }
        break
      case 'darwin':
        this.platformVars = {
          url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz',
          extract: (resolve, reject) => {
            const {Unpack} = require('tar')

            mkdirp.sync(this._options.binDir)

            return new Unpack({
              cwd: this._options.binDir
            }).on('close', () => {
              try {
                fs.accessSync(this.exePath, fs.constants.X_OK)
                resolve()
              } catch (ex) {
                reject(ex)
              }
            })
          },
          exeName: 'steamcmd.sh',
          shellName: 'bash',
          echoExitCode: 'echo $?'
        }
        break
      case 'linux':
        this.platformVars = {
          url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
          extract: (resolve, reject) => {
            const {Unpack} = require('tar')

            mkdirp.sync(this._options.binDir)

            return new Unpack({
              cwd: this._options.binDir
            }).on('close', () => {
              try {
                fs.accessSync(this.exePath, fs.constants.X_OK)
                resolve()
              } catch (ex) {
                reject(ex)
              }
            })
          },
          exeName: 'steamcmd.sh',
          shellName: 'bash',
          echoExitCode: 'echo $?'
        }
        break
      default:
        throw new Error(`Platform "${process.platform}" is not supported`)
    }
  }

  /**
   * The path to the executable. This is defined as a getter, as opposed to a
   * variable, because the user can change the bin directory and we want that
   * change to propagate.
   * @type {string}
   */
  get exePath () {
    return path.join(this._options.binDir, this.platformVars.exeName)
  }

  /**
   * Returns a promise that resolves after ms milliseconds
   */
  static _timeout (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Takes a func that returns a promise and a set of args to pass it. Returns
   * the promise chained with retries and retry delays.
   */
  async _promiseToRetry (func, ...args) {
    let retries = this._options.retries

    while (retries--) {
      try {
        return await func(...args)
      } catch (e) {
        console.warn(`Exception: "${e.message}", retrying, ${retries} retrie(s) left`)
        await SteamCmd._timeout(this._options.retryDelay)
      }
    }

    throw new Error(`Promise failed after ${retries} retries`)
  }

  async _download () {
    return new Promise((resolve, reject) => {
      let req = request(this.platformVars.url)
      if (process.platform !== 'win32') {
        req = req.pipe(require('zlib').createGunzip())
      }

      req.pipe(this.platformVars.extract(resolve, reject))
    })
  }

  async downloadIfNeeded () {
    try {
      // The file must be accessible and executable
      fs.accessSync(this.exePath, fs.constants.X_OK)
      return
    } catch (ex) {
      // If the exe couldn't be found then download it
      return this._download()
    }
  }

  static get MESSAGE_TYPES () {
    return {
      MESSAGE: 0,
      STEAMCMD_READY: 1,
      PASSWORD_REQUIRED: 2,
      STEAM_GUARD_CODE_REQUIRED: 3,
      LOGGED_IN: 4,
      UPDATING: 5,
      UPDATED: 6
    }
  }

  run (username) {
    // TODO I think a transform stream would be better suited in this case
    // TODO should I maybe use a buffer instead and then decode as JS object?
    const ioStream = {
      stdin: new stream.Writable({
        decodeStrings: false,
        write (chunk, enc, next) {
          steamcmdProcess.write(chunk)
          next()
        }
      }),
      stdout: new stream.Readable({
        read () {}
      })
    }

    // TODO download steamCMD first if it doesn't exist yet
    const steamcmdProcess = pty.spawn(this.exePath, [], {
      cols: 120,
      rows: 30,
      cwd: process.env.HOME,
      env: process.env
    })

    // const steamcmdProcess = spawn(this.exePath)
    let currLine = ''

    steamcmdProcess.on('data', (data) => {
      currLine += stripAnsi(data).replace(/\r\n/g, '\n')
      let lines = currLine.split('\n')
      currLine = lines.pop()

      for (let line of lines) {
        let response = {
          type: SteamCmd.MESSAGE_TYPES.MESSAGE,
          line
        }

        if (line.includes('Loading Steam API...OK')) {
          response.type = SteamCmd.MESSAGE_TYPES.STEAMCMD_READY
          this.steamcmdReady = true
        } else if (line.includes('Waiting for user info...OK')) {
          response.type = SteamCmd.MESSAGE_TYPES.LOGGED_IN
        }

        ioStream.stdout.push(line)
      }

      // if (currLine === '') {
      //   console.warn('CURRENT LINE IS EMPTY!')
      // }
    })

    steamcmdProcess.on('error', (...args) => {
      console.error(args)
    })

    steamcmdProcess.on('close', (code) => {
      // if (code === 0 || code === 7) {
      //   // Steamcmd will occasionally exit with code 7 and be fine.
      //   // This usually happens the first run() after download().
      //   resolve(result)
      // } else {
      //   reject(result)
      // }
      console.log(`child process exited with code ${code}`)
    })

    // steamcmdProcess.write(`& "${this.exePath}"\r`)

    return ioStream
  }

  async touch () {
    return this.run([])
  }

  async getAppInfoOnce (appID) {
    let command = [
      'login anonymous',
      'app_info_request ' + appID,
      'wait',
      'app_info_print ' + appID
    ]
    let proc = await this.run(command)

    // extract & parse info
    let infoTextStart = proc.stdout.indexOf('"' + appID + '"')
    let infoTextEnd = proc.stdout.indexOf('Steam>quit')
    if (infoTextStart === -1 || infoTextEnd === -1) {
      throw new TypeError('getAppInfo() failed to receive expected data.')
    }

    let infoText = proc.stdout.substr(infoTextStart, infoTextEnd - infoTextStart)
    let result = vdf.parse(infoText)[appID]
    if (Object.keys(result).length === 0) {
      throw new TypeError('getAppInfo() received empty app data.')
    }

    return result
  }

  async getAppInfo (appID) {
    return this._promiseToRetry(this.getAppInfoOnce, appID)
  }

  // TODO allow the user to force the platform type
  async updateAppOnce (appId) {
    if (!path.isAbsolute(this._options.installDir)) {
      // throw an error immediately because it's invalid data, not a failure
      throw new TypeError('installDir must be an absolute path in updateApp')
    }

    let commands = [
      '@ShutdownOnFailedCommand 0',
      'login anonymous',
      `force_install_dir ${this._options.installDir}`,
      'app_update ' + appId
    ]
    let proc = await this.run(commands)

    if (proc.stdout.indexOf(`Success! App '${appId}' fully installed`) !== -1) {
      return true
    } else if (proc.stdout.indexOf(`Success! App '${appId}' already up to date`) !== -1) {
      return false
    } else {
      let err = proc.stdout.split('\n').slice(-2)[0]
      throw new Error(`Unable to update ${appId}. SteamCMD error was: "${err}"`)
    }
  }

  async updateApp (appId) {
    return this._promiseToRetry(this.updateAppOnce, appId)
  }

  async prep () {
    await this.downloadIfNeeded()
    await SteamCmd._timeout(500)
    return this.touch()
  }
}
