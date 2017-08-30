const path = require('path')
const fs = require('fs-extra')
const request = require('request')

// TODO this is used only once. Maybe I should just import that one required
// function or just write it myself...
const _ = require('lodash')

const tmp = require('tmp-promise')

const { spawn } = require('child_process')
const { Readable } = require('stream')

const stripAnsi = require('strip-ansi')
const mkdirp = require('mkdirp')

const treeKill = require('tree-kill')

const EXIT_CODES = {
  PROCESS_KILLED: null,
  NO_ERROR: 0,
  UNKNOWN_ERROR: 1,
  ALREADY_LOGGED_IN: 2,
  NO_CONNECTION: 3,
  INVALID_PASSWORD: 5,
  STEAM_GUARD_CODE_REQUIRED: 63
}

module.exports = class SteamCmd {
  constructor (options) {
    this._defaultOptions = {
      binDir: path.join(__dirname, 'steamcmd_bin', process.platform),
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

  _getLoginStr () {
    const login = ['login', `"${this._options.username}"`]

    if (this._options.password) {
      login.push([`"${this._options.password}"`])
    }

    if (this._options.steamGuardCode) {
      login.push(`"${this._options.steamGuardCode}"`)
    }

    return login.join(' ')
  }

  setOptions (options) {
    for (let key of Object.keys(options)) {
      this._options[key] = options[key]
    }
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
      await fs.access(this.exePath, fs.constants.X_OK)
      return
    } catch (ex) {
      // If the exe couldn't be found then download it
      return this._download()
    }
  }

  static get EXIT_CODES () {
    return EXIT_CODES
  }

  static getErrorMessage (exitCode) {
    switch (exitCode) {
      case SteamCmd.EXIT_CODES.PROCESS_KILLED:
        return 'The SteamCMD process was killed prematurely'
      case SteamCmd.EXIT_CODES.NO_ERROR:
        return 'No error'
      case SteamCmd.EXIT_CODES.UNKNOWN_ERROR:
        return 'An unknown error occurred'
      case SteamCmd.EXIT_CODES.ALREADY_LOGGED_IN:
        return 'A user was already logged into StremCMD'
      case SteamCmd.EXIT_CODES.NO_CONNECTION:
        return 'SteamCMD cannot connect to the internet'
      case SteamCmd.EXIT_CODES.INVALID_PASSWORD:
        return 'Invalid password'
      case SteamCmd.EXIT_CODES.TEAM_GUARD_CODE_REQUIRED:
        return 'A Steam Guard code was required to log in'
      default:
        return `An unknown error occurred. Exit code: ${exitCode}`
    }
  }

  _run (commands) {
    // We want these vars to be set to these values by default. They can still
    // be overwritten by setting them in the `commands` array.
    commands.unshift('@ShutdownOnFailedCommand 1')
    commands.unshift('@NoPromptForPassword 1')
    // Appending the 'quit' command to make sure that SteamCMD will quit.
    commands.push('quit')

    const runObj = {
      outputStream: new Readable({
        encoding: 'utf8',
        read () {}
      }),
      killSteamCmd: () => {}
    }

    tmp.file().then(commandFile => {
      return fs.appendFile(commandFile.path, commands.join('\n') + '\n')
        .then(() => commandFile)
    }).then(commandFile => {
      const steamcmdProcess = spawn(this.exePath, [
        `+runscript ${commandFile.path}`
      ])

      let currLine = ''
      let exitCode = SteamCmd.EXIT_CODES.NO_ERROR

      runObj.killSteamCmd = () => {
        treeKill(steamcmdProcess.pid, 'SIGTERM', (err) => {
          if (err) {
            runObj.outputStream.emit('error', err)
            runObj.outputStream.destroy()
          }

          // If no error occurred then this will trigger the "close" event on
          // the SteamCMD process; this will then wrap-up everything.
        })
      }

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

          runObj.outputStream.push(line)
        }
      })

      steamcmdProcess.on('error', (err) => {
        runObj.outputStream.emit('error', err)
        runObj.outputStream.destroy()
      })

      steamcmdProcess.on('close', (code) => {
        if (exitCode === SteamCmd.EXIT_CODES.NO_ERROR) {
          exitCode = code
        }

        runObj.outputStream.emit('close', exitCode)
        runObj.outputStream.destroy()
      })
    })

    return runObj
  }

  /**
   * Note: this can take a very long time, especially if the binaries had to
   * be freshly downloaded. This is because SteamCMD will first do an update
   * before running the command.
   */
  async _touch () {
    return new Promise((resolve, reject) => {
      const {outputStream} = this._run([])

      outputStream.on('close', () => { resolve() })
      outputStream.on('error', (err) => { reject(err) })
    })
  }

  // TODO add the ability to stop a download. Currently this is not possible.
  updateApp (appId, platformType = null, platformBitness = null) {
    if (!path.isAbsolute(this._options.installDir)) {
      // throw an error immediately because it's invalid data, not a failure
      throw new TypeError('installDir must be an absolute path to update an app')
    }

    const commands = [
      this._getLoginStr(),
      `force_install_dir "${this._options.installDir}"`,
      'app_update ' + appId
    ]

    if (platformBitness === 32 ||
        platformBitness === 64) {
      commands.unshift('@sSteamCmdForcePlatformBitness ' + platformBitness)
    }

    if (platformType === 'windows' ||
        platformType === 'macos' ||
        platformType === 'linux') {
      commands.unshift('@sSteamCmdForcePlatformType ' + platformType)
    }

    return this._run(commands)
  }

  async prep () {
    await this.download()
    return this._touch()
  }
}
