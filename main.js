const path = require('path')
const fs = require('fs')
const defaults = require('lodash.defaults')
const tmp = require('tmp-promise')
const axios = require('axios')
const { spawn } = require('child_process')
const { Readable } = require('stream')
const stripAnsi = require('strip-ansi')
const treeKill = require('tree-kill')
const yauzl = require('yauzl')

// TODO: correct all warnings
// TODO: use "yauzl" instead of "unzip"
// TODO: make use of class properties
// TODO: make use of async generators

/**
 * @typedef {Object} RunObj
 * @property {Readable} outputStream A readable stream that returns the output
 * of the SteamCMD process. It also closes with the correct exit code.
 * @see EXIT_CODES
 * @property {Function} killSteamCmd A function that, once called, kills the
 * SteamCMD process and destroys `outputStream`.
 */

/**
 * This class acts as an intermediate layer between SteamCMD and NodeJS. It
 * allows you to download the SteamCMD binaries, login with a custom user
 * account, update an app, etc.
 */
class SteamCmd {
  /**
   * These are all exit codes that SteamCMD can use. This is not an exhaustive
   * list yet.
   * @namespace
   * @property {null} PROCESS_KILLED Indicates that the SteamCMD process was
   * forcefully killed.
   * @property {number} NO_ERROR Indicates that SteamCMD exited normally.
   * @property {number} UNKNOWN_ERROR Indicates that some unknown error
   * occurred.
   * @property {number} ALREADY_LOGGED_IN Indicates that the user attemted to
   * login while another user was already logged in.
   * @property {number} NO_CONNECTION Indicates that SteamCMD has no connection
   * to the internet.
   * @property {number} INVALID_PASSWORD Indicates that an incorrect password
   * was provided.
   * @property {number} STEAM_GUARD_CODE_REQUIRED Indicated that a Steam guard
   * code is required before the login can finish.
   */
  static EXIT_CODES = {
    PROCESS_KILLED: null,
    NO_ERROR: 0,
    UNKNOWN_ERROR: 1,
    ALREADY_LOGGED_IN: 2,
    NO_CONNECTION: 3,
    INVALID_PASSWORD: 5,
    STEAM_GUARD_CODE_REQUIRED: 63
  }

  /**
   * All the options that are used by SteamCmd
   * @namespace
   * @property {string} binDir The directory into which the SteamCMD binaries
   * will be downloaded.
   * @property {string} installDir The directory into which the steam apps will
   * be downloaded.
   * @property {string} username The username to use for login.
   * @property {string} password The password to use for login.
   * @property {string} steamGuardCode The steam guard code to use for login.
   */
  #options = {
    binDir: path.join(__dirname, 'steamcmd_bin', process.platform),
    installDir: path.join(__dirname, 'install_dir'),
    username: 'anonymous',
    password: '',
    steamGuardCode: ''
  }

  /**
   * Variables that change based on the platform that this is run on
   * @namespace
   * @property {string} downloadUrl The URL from which the Steam CMD executable
   * can be downloaded
   * @property {string} exeName The name of the final Steam CMD executable after
   * extraction.
   * @property {Function} extract Extracts the Steam CMD executable from the
   * given file descriptor (must be an archive)
   */
  #platformVariables = {
    downloadUrl: '',
    exeName: '',
    extract: async (_fileDescriptor) => {
      throw new Error('Not Implemented')
    }
  }

  /**
   * Constructs a new SteamCmd object.
   * @param {Object} [options={}] The operational options that SteamCmd should
   * use. Defaults are provided.
   */
  constructor (options = {}) {
    defaults(this.#options, options)

    // TODO: create directories

    // Some platform-dependent setup
    switch (process.platform) {
      case 'win32':
        this.#platformVariables.downloadUrl =
          'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
        this.#platformVariables.exeName = 'steamcmd.exe'
        this.#platformVariables.extract = this.#extractZip

        break
      case 'darwin':
        this.#platformVariables.downloadUrl =
          'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz'
        this.#platformVariables.exeName = 'steamcmd.sh'
        this.#platformVariables.extract = this.#extractTar

        break
      case 'linux':
        this.#platformVariables.downloadUrl =
          'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz'
        this.#platformVariables.exeName = 'steamcmd.sh'
        this.#platformVariables.extract = this.#extractTar

        break
      default:
        throw new Error(`Platform "${process.platform}" is not supported`)
    }
  }

  /**
   * A publicly accessible getter to get the Steam CMD executable
   * @type {string}
   */
  get exePath () {
    return path.join(this.#options.binDir, this.#platformVariables.exeName)
  }

  /**
   * A publicly accessible getter to get the current directory to which
   * applications will be installed.
   * @type {string}
   */
  get installDir () {
    return this.#options.installDir
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

  async #extractZip (fileDescriptor) {
    const zipFile = await new Promise((resolve, reject) => {
      yauzl.fromFd(fileDescriptor,
        { lazyEntries: true },
        (err, zipFile) => {
          if (err) reject(err)
          else resolve(zipFile)
        })
    })

    const executableEntry = await new Promise((resolve, reject) => {
      zipFile.on('end', () => {
        reject(new Error('Steam CMD executable not found in archive'))
      })
      zipFile.on('error', reject)
      zipFile.on('entry', entry => {
        if (entry.fileName === this.#platformVariables.exeName) {
          resolve(entry)
        } else {
          zipFile.readEntry()
        }
      })

      zipFile.readEntry()
    })

    await new Promise(resolve => {
      zipFile.openReadStream(executableEntry, (err, readStream) => {
        if (err) throw err

        const exeFileWriteStream = fs.createWriteStream(this.exePath)

        readStream.pipe(exeFileWriteStream)
        exeFileWriteStream.on('finish', resolve)
      })
    })

    zipFile.close()
  }

  async #extractTar (fileDescriptor) {
    // TODO: implement
  }

  /**
   * Downloads and unzips SteamCMD for the current platform into the `binDir`
   * defined in `this.#options`.
   * @private
   * @returns {Promise} Resolves when the SteamCMD binary has been successfully
   * downloaded and extracted. Rejects otherwise.
   */
  async _downloadSteamCmd () {
    const tempFile = await tmp.file()

    const responseStream = await axios.get(this.#platformVariables.downloadUrl,
      { responseType: 'stream' })

    const tempFileWriteStream = fs.createWriteStream(tempFile.path)

    responseStream.data.pipe(tempFileWriteStream)
    await new Promise(resolve => {
      tempFileWriteStream.on('finish', resolve)
    })

    await this.#platformVariables.extract(tempFile.fd)

    // Cleanup the temp file
    tempFile.cleanup()
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

    } catch (ex) {
      // If the exe couldn't be found then download it
      return this._downloadSteamCmd()
    }
  }

  /**
   * Gets the login command string based on the user config in `this.#options`
   * @returns {string}
   */
  getLoginStr () {
    const login = ['login', `"${this.#options.username}"`]

    if (this.#options.password) {
      login.push(`"${this.#options.password}"`)
    }

    if (this.#options.steamGuardCode) {
      login.push(`"${this.#options.steamGuardCode}"`)
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
   * Downloads or updates the specified Steam app. If this app has been
   * partially downloaded in the current install directory then this will
   * simply continue that download process.
   * @param {number} appId The ID of the app to download.
   * @param {string} [platformType] The platform type of the app that you want
   * to download. If not set then this will use the current platform the user
   * is on. Must be one of "windows", "macos", or "linux".
   */
  updateApp (appId, platformType, platformBitness) {
    if (!path.isAbsolute(this.#options.installDir)) {
      // throw an error immediately because SteamCMD doesn't support relative
      // install directories.
      throw new TypeError(
        'installDir must be an absolute path to update an app')
    }

    const commands = [
      this.getLoginStr(),
      `force_install_dir "${this.#options.installDir}"`,
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
