const path = require('path')
const fs = require('fs-extra')
const request = require('request')

// TODO this is used only once. Maybe I should just import that one required
// function or just write it myself...
const _ = require('lodash')

/**
 * VDF is a data format that valve uses. This package can convert between JSON
 * and VDF.
 */
const vdf = require('vdf')

const tmp = require('tmp-promise')

const { spawn } = require('child_process')
const { Readable } = require('stream')

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
      installDir: path.join(__dirname, 'install_dir'),
      username: 'anonymous',
      password: '',
      steamGuardCode: ''
    }
    this._options = _.defaults({}, options, this._defaultOptions)

    // Some platform-dependent setup
    switch (process.platform) {
      case 'win32':
        this.platformVars = {
          url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
          extract: (resolve, reject) => {
            // TODO use "yauzl" instead of "unzip". It is more regularly updated and more
            // popular
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

  get _loginStr () {
    return `login "${this._options.username}" "${this._options.password}" "${this._options.steamGuardCode}"`
  }

  setOptions (options) {
    for (let key of Object.keys(options)) {
      this._options[key] = options[key]
    }
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

  async download () {
    try {
      // The file must be accessible and executable
      fs.accessSync(this.exePath, fs.constants.X_OK)
      return
    } catch (ex) {
      // If the exe couldn't be found then download it
      return this._download()
    }
  }

  static get EXIT_CODES () {
    return {
      NO_ERROR: 0,
      UNKNOWN_ERROR: 1,
      ALREADY_LOGGED_IN: 2,
      NO_CONNECTION: 3,
      INVALID_PASSWORD: 5,
      STEAM_GUARD_CODE_REQUIRED: 63
    }
  }

  _run (commands) {
    // We want these vars to be set to these values by default. They can still
    // be overwritten by setting them in the `commands` array.
    commands.unshift('@ShutdownOnFailedCommand 1')
    commands.unshift('@NoPromptForPassword 1')
    // Appending the 'quit' command to make sure that SteamCMD will quit.
    commands.push('quit')

    const outputStream = new Readable({
      encoding: 'utf8',
      read () {}
    })

    tmp.file().then(commandFile => {
      return fs.appendFile(commandFile.path, commands.join('\n') + '\n')
        .then(() => commandFile)
    }).then(commandFile => {
      const steamcmdProcess = spawn(this.exePath, [
        `+runscript ${commandFile.path}`
      ])

      let currLine = ''
      let exitCode = SteamCmd.EXIT_CODES.NO_ERROR

      steamcmdProcess.stdout.on('data', (data) => {
        currLine += stripAnsi(data.toString('utf8')).replace(/\r\n/g, '\n')
        let lines = currLine.split('\n')
        currLine = lines.pop()

        for (let line of lines) {
          if (line.includes('FAILED with result code 5')) {
            exitCode = SteamCmd.EXIT_CODES.INVALID_PASSWORD
          } else if (line.includes('FAILED with result code 63')) {
            exitCode = SteamCmd.EXIT_CODES.STEAM_GUARD_CODE_REQUIRED
          } else if (line.includes('FAILED with result code 2')) {
            exitCode = SteamCmd.EXIT_CODES.ALREADY_LOGGED_IN
          } else if (line.includes('FAILED with result code 3')) {
            exitCode = SteamCmd.EXIT_CODES.NO_CONNECTION
          }

          outputStream.push(line)
        }
      })

      steamcmdProcess.on('error', (err) => {
        outputStream.emit('error', err)
        outputStream.destroy()
      })

      steamcmdProcess.on('close', (code) => {
        if (exitCode === SteamCmd.EXIT_CODES.NO_ERROR) {
          exitCode = code
        }

        outputStream.emit('close', exitCode)
        outputStream.destroy()
      })
    })

    return outputStream
  }

  /**
   * Note: this can take a very long time, especially if the binaries had to
   * be freshly downloaded. This is because SteamCMD will first do an update
   * before running the command.
   */
  async touch () {
    return new Promise((resolve, reject) => {
      const stream = this._run([])

      stream.on('close', () => { resolve() })
      stream.on('error', (err) => { reject(err) })
    })
  }

  async getAppInfoOnce (appID) {
    // TODO it may be better to get app info via Steam's web API. In this way
    // I can cut down on a dependency and I don't need to spin up a new SteamCMD
    // instance.
    // Ok, well it turns out that you need a auth key before you can the web API.
    // But I'm sure there has to be a way to just get the app info.

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
    await this.download()
    await SteamCmd._timeout(500)
    return this.touch()
  }
}
