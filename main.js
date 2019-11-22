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
const tar = require('tar')
const fileType = require('file-type')

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
   * @readonly
   * @enum {number}
   */
  static EXIT_CODES = {
    /**
     * Indicates that the SteamCMD process was forcefully killed.
     * @type {null}
     */
    PROCESS_KILLED: null,
    /**
     * Indicates that SteamCMD exited normally.
     */
    NO_ERROR: 0,
    /**
     * Indicates that some unknown error occurred.
     */
    UNKNOWN_ERROR: 1,
    /**
     * Indicates that the user attempted to login while another user was already
     * logged in.
     */
    ALREADY_LOGGED_IN: 2,
    /**
     * Indicates that SteamCMD has no connection to the internet.
     */
    NO_CONNECTION: 3,
    /**
     * Indicates that an incorrect password was provided.
     */
    INVALID_PASSWORD: 5,
    /**
     * Indicated that a Steam guard code is required before the login can
     * finish.
     */
    STEAM_GUARD_CODE_REQUIRED: 63
  }

  /**
   * The directory into which the SteamCMD binaries will be downloaded.
   * @type {string}
   */
  #binDir = path.join(__dirname, 'steamcmd_bin', process.platform)

  /**
   * The directory into which the steam apps will be downloaded.
   * @type {string}
   */
  #installDir = path.join(__dirname, 'install_dir')

  // TODO: each one of these should be a property of this class. Some should be
  // private that can only be initialised upon construction and some public.
  /**
   * All the options that are used by SteamCmd
   * @namespace
   * @property {string} binDir
   * @property {string} installDir
   * @property {string} username The username to use for login.
   * @property {string} password The password to use for login.
   * @property {string} steamGuardCode The steam guard code to use for login.
   */
  #options = {
    // TODO: this is an issue, because you only need to login once and then
    // SteamCMD will store the login details until manually deleted. I think
    // that instead of making this a property there should be a dedicated login
    // function.

    // TODO: this is how the login issue will be solved:
    // - Add the username as a class property. It will be passed to the
    // constructor
    // - Add a "isLoggedIn" function. It will return true if the user is logged
    // in, and false otherwise
    // - Add a "login" function that will accept the username (which will
    // overwrite the class property), the password, and the steam guard code.
    // It will log the user in. Only the username will be stored in the class.

    // FIXME: A blank steam guard code results in the script getting stuck when
    // logging in
    username: 'anonymous',
    password: '',
    steamGuardCode: ''
  }

  /**
   * The URL from which the Steam CMD executable can be downloaded. Changes
   * depending on the current platform.
   * @type {string}
   */
  #downloadUrl = ''

  /**
   * The name of the final Steam CMD executable after extraction. Changes
   * depending on the current platform.
   * @type {string}
   */
  #exeName = ''

  /**
   * Constructs a new SteamCmd object.
   * @param {Object} [options={}] The operational options that SteamCmd should
   * use. Defaults are provided.
   */
  constructor (options = {}) {
    defaults(this.#options, options)

    // Some platform-dependent setup
    switch (process.platform) {
      case 'win32':
        this.#downloadUrl =
          'https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip'
        this.#exeName = 'steamcmd.exe'
        break
      case 'darwin':
        this.#downloadUrl =
          'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz'
        this.#exeName = 'steamcmd.sh'
        break
      case 'linux':
        this.#downloadUrl =
          'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz'
        this.#exeName = 'steamcmd.sh'
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
    return path.join(this.#binDir, this.#exeName)
  }

  /**
   * A publicly accessible getter to get the current directory to which
   * applications will be installed.
   * @type {string}
   */
  get installDir () {
    return this.#installDir
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
      case SteamCmd.EXIT_CODES.STEAM_GUARD_CODE_REQUIRED:
        return 'A Steam Guard code was required to log in'
      default:
        return `An unknown error occurred. Exit code: ${exitCode}`
    }
  }

  /**
   * Extracts the Steam CMD executable from the given file path.
   * @param {string} path The path to the archive in which the Steam CMD
   * executable resides.
   */
  async _extractArchive (path) {
    const fileHandle = await fs.promises.open(path, 'r')

    const { buffer } = await fileHandle.read(
      Buffer.alloc(fileType.minimumBytes),
      0,
      fileType.minimumBytes,
      0)

    await fileHandle.close()

    switch (fileType(buffer).mime) {
      case 'application/gzip':
        return this._extractTar(path)
      case 'application/zip':
        return this._extractZip(path)
      default:
        throw new Error('Archive format not recognised')
    }
  }

  /**
   * Extracts the Steam CMD executable from the zip file located at the
   * specified path.
   * @param {string} path The path to the zip file in which the Steam CMD
   * executable is located.
   * @returns {Promise<void>} Resolves once the Steam CMD executable has been
   * successfully extracted.
   * @throws {Error} When the executable couldn't be found in the archive.
   * @private
   */
  async _extractZip (path) {
    // Open the zip file
    const zipFile = await new Promise((resolve, reject) => {
      yauzl.open(path,
        { lazyEntries: true },
        (err, zipFile) => {
          if (err) reject(err)
          else resolve(zipFile)
        })
    })

    // Find the entry for the Steam CMD executable
    const executableEntry = await new Promise((resolve, reject) => {
      zipFile.on('end', () => {
        reject(new Error('Steam CMD executable not found in archive'))
      })
      zipFile.on('error', reject)
      zipFile.on('entry', entry => {
        if (entry.fileName === this.#exeName) {
          resolve(entry)
        } else {
          zipFile.readEntry()
        }
      })

      zipFile.readEntry()
    })

    // Extract the executable to its destination path
    await new Promise((resolve, reject) => {
      zipFile.openReadStream(executableEntry, (err, readStream) => {
        if (err) throw err

        const exeFileWriteStream = fs.createWriteStream(this.exePath)

        readStream.pipe(exeFileWriteStream)
        exeFileWriteStream.on('finish', resolve)
        exeFileWriteStream.on('error', reject)
      })
    })

    // Finally close the zip
    zipFile.close()
  }

  /**
   * Extracts the Steam CMD executable from the tar file located at the
   * specified path. This tar file may be gzipped.
   * @param {string} path The path to the tar file in which the Steam CMD
   * executable is located.
   * @returns {Promise<void>} Resolves once the Steam CMD executable has been
   * successfully extracted.
   * @throws {Error} When the executable couldn't be found in the archive.
   * @private
   */
  async _extractTar (path) {
    // Extract the tar file. By using the filter we only extract the Steam CMD
    // executable.

    // noinspection JSUnusedGlobalSymbols
    await tar.extract({
      cwd: this.#binDir,
      strict: true,
      file: path,
      filter: (_, entry) => entry.path === this.#exeName
    })

    try {
      // Test if the file is accessible and executable
      await fs.promises.access(this.exePath, fs.constants.X_OK)
    } catch (ex) {
      // If the Steam CMD executable wasn't extracted then it means that it was
      // never in the archive to begin with. Throw an error.
      throw new Error('Steam CMD executable not found in archive')
    }
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

    const responseStream = await axios.get(this.#downloadUrl,
      { responseType: 'stream' })

    const tempFileWriteStream = fs.createWriteStream(tempFile.path)

    responseStream.data.pipe(tempFileWriteStream)
    await new Promise(resolve => {
      tempFileWriteStream.on('finish', resolve)
    })

    await this._extractArchive(tempFile.path)

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
      await fs.promises.access(this.exePath, fs.constants.X_OK)
    } catch (ex) {
      // Create the directories if need be
      await fs.promises.mkdir(this.#binDir, { recursive: true })

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
    // TODO: this class should be an async generator.

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
      return fs.promises.appendFile(commandFile.path,
        commands.join('\n') + '\n')
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
        const lines = currLine.split('\n')
        currLine = lines.pop()

        for (const line of lines) {
          // FIXME: steamCMD no longer uses these exit codes. It now fails with
          // a message. For example: "FAILED login with result code Two-factor
          // code mismatch"
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
   * to download. If omitted then this will use the current platform. Must be
   * one of "windows", "macos", or "linux".
   * @param {number} [platformBitness] Indicates the bitness of the platform.
   * Can be either 32 or 64. If omitted then this will use the current
   * platform's bitness.
   */
  async updateApp (appId, platformType, platformBitness) {
    if (!path.isAbsolute(this.#installDir)) {
      // throw an error immediately because SteamCMD doesn't support relative
      // install directories.
      throw new TypeError(
        'installDir must be an absolute path to update an app')
    }

    // Create the install directory if need be
    await fs.promises.mkdir(this.#installDir, { recursive: true })

    const commands = [
      this.getLoginStr(),
      `force_install_dir "${this.#installDir}"`,
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

exports.SteamCmd = SteamCmd
