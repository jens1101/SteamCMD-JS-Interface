const path = require('path')
const fs = require('fs-extra')
const request = require('request')
const defaults = require('lodash.defaults')
const tmp = require('tmp-promise')
const { spawn } = require('child_process')
const { Readable } = require('stream')
const stripAnsi = require('strip-ansi')
const mkdirp = require('mkdirp')
const treeKill = require('tree-kill')

// TODO: correct all warnings
// TODO: use "yauzl" instead of "unzip"
// TODO: rename this file to main.mjs
// TODO: make use of class properties

/**
 * @typedef {Object} RunObj
 * @property {Readable} outputStream A readable stream that returns the output
 * of the SteamCMD process. It also closes with the correct exit code.
 * @see EXIT_CODES
 * @property {Function} killSteamCmd A function that, once called, kills the
 * SteamCMD process and destroys `outputStream`.
 */

/**
 * These are all exit codes that SteamCMD can use. This is not an exhaustive
 * list yet.
 * @namespace
 * @property {null} PROCESS_KILLED Indicates that the SteamCMD process was
 * forcefully killed.
 * @property {number} NO_ERROR Indicates that SteamCMD exited normally.
 * @property {number} UNKNOWN_ERROR Indicates that some unknown error occurred.
 * @property {number} ALREADY_LOGGED_IN Indicates that the user attemted to
 * login while another user was already logged in.
 * @property {number} NO_CONNECTION Indicates that SteamCMD has no connection to
 * the internet.
 * @property {number} INVALID_PASSWORD Indicates that an incorrect password was
 * provided.
 * @property {number} STEAM_GUARD_CODE_REQUIRED Indicated that a Steam guard
 * code is required before the login can finish.
 */
const EXIT_CODES = {
  PROCESS_KILLED: null,
  NO_ERROR: 0,
  UNKNOWN_ERROR: 1,
  ALREADY_LOGGED_IN: 2,
  NO_CONNECTION: 3,
  INVALID_PASSWORD: 5,
  STEAM_GUARD_CODE_REQUIRED: 63
}

/**
 * All the options that are used by SteamCmd by default.
 * @namespace
 * @property {string} binDir The directory into which the SteamCMD binaries
 * will be downloaded.
 * @property {string} installDir The directory into which the steam apps will
 * be downloaded.
 * *Note*: If you have the Steam client installed then you can set this to it's
 * default library folder (default on Windows is 'C:\Program Files
 * (x86)\Steam\'). This will ensure that Steam will recognise the game on
 * startup and you don't need to manually copy anything.
 * @property {string} username The username to use for login.
 * @property {string} password The password to use for login.
 * @property {string} steamGuardCode The steam guard code to use for login.
 */
const DEFAULT_OPTIONS = {
  binDir: path.join(__dirname, 'steamcmd_bin', process.platform),
  installDir: path.join(__dirname, 'install_dir'),
  username: 'anonymous',
  password: '',
  steamGuardCode: ''
}

/**
 * This class acts as an intermediate layer between SteamCMD and NodeJS. It
 * allows you to download the SteamCMD binaries, login with a custom user
 * account, update an app, etc.
 */
class SteamCmd {
  /**
   * Simple accessor that makes the default options a static variable.
   * @see DEFAULT_OPTIONS
   * @type {Object}
   */
  static get DEFAULT_OPTIONS () {
    return DEFAULT_OPTIONS
  }

  /**
   * Simple accessor that makes the exit codes a static variable.
   * @see EXIT_CODES
   * @type {Object}
   */
  static get EXIT_CODES () {
    return EXIT_CODES
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
   * A publicly accessible getter to get the current install directory
   * @type {string}
   */
  get installDir () {
    return this._options.installDir
  }

  /**
   * Constucts a new SteamCmd object.
   * @param {Object} [options={}] The operational options that SteamCmd should
   * use. Defaults are provided.
   */
  constructor (options = {}) {
    this._options = defaults({}, options, SteamCmd.DEFAULT_OPTIONS)

    // Some platform-dependent setup
    switch (process.platform) {
      case 'win32':
        this.platformVars = {
          url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip',
          extract: (resolve, reject) => {
            const { Extract } = require('unzip')

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
            const { Unpack } = require('tar')

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
            const { Unpack } = require('tar')

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
   * Downloads and unzips SteamCMD for the current platform into the `binDir`
   * defined in `this._options`.
   * @private
   * @returns {Promise} Resolves when the SteamCMD binary has been successfully
   * downloaded and extracted. Rejects otherwise.
   */
  async _downloadSteamCmd () {
    return new Promise((resolve, reject) => {
      let req = request(this.platformVars.url)
      if (process.platform !== 'win32') {
        req = req.pipe(require('zlib').createGunzip())
      }

      req.pipe(this.platformVars.extract(resolve, reject))
    })
  }

  /**
   * Makes sure that SteamCMD is usable on this system.
   * *Note*: this can take a very long time to run for the first time after
   * downloading SteamCMD. This is because SteamCMD will first do an update
   * before running the command and quitting.
   * @private
   * @returns {Promise} Resovles once the SteamCMD process exited normally.
   * Rejects otherwise.
   */
  async _touch () {
    return new Promise((resolve, reject) => {
      const { outputStream } = this.run([])

      outputStream.on('close', () => { resolve() })
      outputStream.on('error', (err) => { reject(err) })
    })
  }

  /**
   * Download the SteamCMD binaries if they are not installed in the current
   * install directory.
   * @returns {Promise} Resolves once the binaries have been downloaded.
   */
  async downloadSteamCmd () {
    try {
      // The file must be accessible and executable
      await fs.access(this.exePath, fs.constants.X_OK)
      return
    } catch (ex) {
      // If the exe couldn't be found then download it
      return this._downloadSteamCmd()
    }
  }

  /**
   * Convenience function that returns an appropriate error message for the
   * given exit code.
   * @param exitCode The exit code to get a message for.
   * @returns {string}
   */
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

  /**
   * Gets the login command string based on the user config in `this._options`
   * @returns {string}
   */
  getLoginStr () {
    const login = ['login', `"${this._options.username}"`]

    if (this._options.password) {
      login.push(`"${this._options.password}"`)
    }

    if (this._options.steamGuardCode) {
      login.push(`"${this._options.steamGuardCode}"`)
    }

    return login.join(' ')
  }

  /**
   * Convenience function that ensures that SteamCMD is ready to use. It
   * downloads the SteamCMD binaries and runs an empty script. Once that
   * finishes then SteamCMD is ready to use.
   * *Note*: this can take a very long time, especially if the binaries had to
   * be freshly downloaded. This is because SteamCMD will first do an update
   * before running the command.
   * @returns {Promise} Resolves once SteamCMD has been downloaded and is ready
   * to use.
   */
  async prep () {
    await this.downloadSteamCmd()
    return this._touch()
  }

  /**
   * Runs the specified commands in a new SteamCMD instance. Internally this
   * function creates a temporary file, writes the commands to it, executes the
   * file as a script, and then finally quits.
   * @returns {RunObj}
   */
  run (commands) {
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
      // TODO this doesn't feel right. I should instead defer the process kill
      // until after the process has spawned or (possibly) prevent the process
      // from spawning at all.
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
   * Allows you to set or update one or more options that this instance will
   * use.
   * @param {Object} An object that maps out each key and value that you want
   * to set. This will update the current internal options object.
   */
  setOptions (options) {
    for (let key of Object.keys(options)) {
      this._options[key] = options[key]
    }
  }

  /**
   * Downloads or updates the specified Steam app. If this app has been
   * partially downloaded in the current install directory then this will
   * simply continue that download process.
   * @param {number} appId The ID of the app to download.
   * @param {string} [platformType] The platform type of the app that you want
   * to download. If not set then this will use the current platform the user
   * is on. Must be one of "windows", "macos", or "linux".
   */
  updateApp (appId, platformType, platformBitness) {
    if (!path.isAbsolute(this._options.installDir)) {
      // throw an error immediately because SteamCMD doesn't support relative
      // install directories.
      throw new TypeError(
        'installDir must be an absolute path to update an app')
    }

    const commands = [
      this.getLoginStr(),
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

    return this.run(commands)
  }
}

module.exports = SteamCmd
