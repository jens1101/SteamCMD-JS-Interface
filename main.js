const path = require('path')
const fs = require('fs')
const tmp = require('tmp-promise')
const axios = require('axios')
const { spawn } = require('child_process')
const stripAnsi = require('strip-ansi')
const yauzl = require('yauzl')
const tar = require('tar')
const fileType = require('file-type')
const { Readable } = require('stream')

// TODO: update Readme
// TODO: This class is bloated. Create a utility file that this class can use.

/**
 * This class acts as an intermediate layer between SteamCMD and NodeJS. It
 * allows you to download the SteamCMD binaries, login with a custom user
 * account, update an app, etc.
 */
class SteamCmd {
  // TODO: I think we can delete this.
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
   * Used to indicate to the constructor that it's being legally called.
   * `SteamCmd.init` sets this to true and then calls the constructor. If this
   * is false and the constructor is called then it will throw an exception.
   * @type {boolean}
   */
  static #initialising = false

  /**
   * The directory into which the SteamCMD binaries will be downloaded.
   * @type {string}
   */
  #binDir

  /**
   * The directory into which the steam apps will be downloaded.
   * @type {string}
   */
  #installDir

  /**
   * The username to use for login.
   * @type {string}
   */
  #username

  /**
   * The URL from which the Steam CMD executable can be downloaded. Changes
   * depending on the current platform.
   * @type {string}
   */
  #downloadUrl

  /**
   * The name of the final Steam CMD executable after extraction. Changes
   * depending on the current platform.
   * @type {string}
   */
  #exeName

  /**
   * The currently running Steam CMD process. If no process is running then this
   * will be `null`.
   * @type {ChildProcess|null}
   */
  #currentSteamCmdProcess = null

  /**
   * Constructs a new SteamCmd instance.
   * **Note** this may not be called directly and will throw an error in such a
   * case. Use `SteamCmd.init` instead.
   * @param {string} binDir The absolute path to where the Steam CMD
   * executable will be downloaded to.
   * @param {string} installDir The absolute path to where Steam apps will be
   * installed to.
   * @param {string} username The username to log into Steam.
   * @see SteamCmd.init
   */
  constructor (binDir, installDir, username) {
    // If the `initialising` variable is not set then throw an error. Direct
    // construction is not allowed.
    if (!SteamCmd.#initialising) {
      throw new Error('Constructor may not be called directly. Use ' +
        '`SteamCmd.init` instead.')
    }

    // Set the `initialising` variable back to false, otherwise direct
    // construction will become possible.
    SteamCmd.#initialising = false

    // Initialise class variables.
    this.#binDir = binDir
    this.#installDir = installDir
    this.#username = username

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
   * Returns the currently running Steam CMD process. This can be used to
   * forcefully kill the process if something goes wrong. If no Steam CMD
   * process is running then this returns `null` instead.
   * @returns {ChildProcess|null}
   */
  get currSteamCmdProcess () {
    return this.#currentSteamCmdProcess
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
   * Creates a new SteamCmd instance. This will download the Steam CMD
   * executable, ensure that it's usable, and then resolve into a new SteamCmd
   * instance.
   * @param {Object} [options] A set of options that affect how SteamCmd works.
   * @param {string} [options.binDir] The absolute path to where the Steam CMD
   * executable will be downloaded to. Defaults to "steamcmd_bin" in the
   * current directory.
   * @param {string} [options.installDir] The absolute path to where Steam apps
   * will be installed to. Defaults to "install_dir" in the current directory.
   * @param {string} [options.username] The username to log into Steam.
   * Defaults to 'anonymous'.
   * @returns {Promise<SteamCmd>} Resolves into a ready-to-be-used SteamCmd
   * instance
   */
  static async init (options) {
    // Set the `initialising` variable to true to indicate to the constructor
    // that it's being legally called.
    SteamCmd.#initialising = true

    const allOptions = Object.assign({
      binDir: path.join(__dirname, 'steamcmd_bin', process.platform),
      installDir: path.join(__dirname, 'install_dir'),
      username: 'anonymous'
    }, options)

    // Construct the new SteamCmd instance
    const steamCmd = new SteamCmd(allOptions.binDir, allOptions.installDir,
      allOptions.username)

    // Download the Steam CMD executable
    await steamCmd.downloadSteamCmd()

    // Test that the executable is in working condition
    // eslint-disable-next-line no-unused-vars
    for await (const line of steamCmd.run([])) {}

    // Finally return the ready-to-be-used instance
    return steamCmd
  }

  /**
   * Log in to a Steam account.
   * @param {string} username The username of the account to which to log in
   * to. Can be "anonymous" for anonymous login. This will update the username
   * that's stored internally.
   * @param {string} [password] The password for the above account. This can be
   * omitted only if you're logging in anonymously, or if your login
   * credentials have already been saved by Steam CMD.
   * @param {string} [steamGuardCode] The Steam Guard code for the above
   * account. This can be omitted only if you're logging in anonymously, if
   * your login credentials have already been saved by Steam CMD, or if your
   * account doesn't have Steam Guard enabled.
   * @returns {Promise<void>} Resolves once the user has been successfully
   * logged in.
   * @throws An error if the login failed in any way.
   */
  async login (username, password, steamGuardCode) {
    this.#username = username

    const login = ['login', `"${this.#username}"`]
    if (password) login.push(`"${password}"`)
    if (steamGuardCode) login.push(`"${steamGuardCode}"`)

    // eslint-disable-next-line no-unused-vars
    for await (const line of this.run([login.join(' ')])) {}
  }

  /**
   * Convenience function to test if the username that's stored internally can
   * log into Steam without requiring a password or Steam Guard code. This can
   * only succeed if Steam CMD previously logged into this account and the
   * account's credentials are still saved locally.
   * @returns {Promise<boolean>} Resolves into `true` if the stored user can
   * log into Steam, `false` otherwise.
   */
  async isLoggedIn () {
    try {
      await this.login(this.#username)
      return true
    } catch {
      return false
    }
  }

  /**
   * Extracts the Steam CMD executable from the given file path.
   * @param {string} path The path to the archive in which the Steam CMD
   * executable resides.
   * @returns {Promise<void>} Resolves once the executable has been extracted.
   * @private
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
   * Downloads and unzips Steam CMD for the current platform into the `binDir`.
   * If the executable already exists then nothing will be downloaded and this
   * will simply resolve.
   * @returns {Promise<void>} Resolves when the Steam CMD executable has been
   * successfully downloaded and extracted. Rejects otherwise.
   * @private
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
   * Download the SteamCMD binaries if they are not installed in the current
   * install directory.
   * @returns {Promise<void>} Resolves once the binaries have been downloaded.
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

  async * run (commands) {
    // By default we want:
    // - Steam CMD to shutdown once it encountered an error
    // - Steam CMD should not prompt for a password, because stdin is not
    //   available in this context.
    //
    // These options can still be overwritten by setting them in the `commands`
    // array.
    commands.unshift('@ShutdownOnFailedCommand 1')
    commands.unshift('@NoPromptForPassword 1')

    // Appending the 'quit' command to make sure that SteamCMD will always quit.
    commands.push('quit')

    // Create a temporary file that will hold our commands
    const commandFile = await tmp.file()
    await fs.promises.appendFile(commandFile.path, commands.join('\n') + '\n')

    // Spawn Steam CMD as a process
    const steamCmdProcess = spawn(this.exePath, [
      `+runscript ${commandFile.path}`
    ])
    this.#currentSteamCmdProcess = steamCmdProcess

    // Create a promise that will resolve once the Steam CMD process closed.
    const closePromise = this.getProcessClosePromise(steamCmdProcess)

    // Create a generator from the process' stdout. This will automatically
    // convert the output data to UTF-8. However output is sent as chunks,
    // instead of line-by-line.
    const stdOutIterator = Readable.from(steamCmdProcess.stdout,
      { encoding: 'utf8' })

    // Convert the chunks to lines and then iterate over them.
    for await (const outputLine of this._chunksToLines(stdOutIterator)) {
      // Strip any ANSI style formatting from the current line of output and
      // then yield it.
      yield `${stripAnsi(outputLine)}`
    }

    // Once the output has been iterated over then wait for the process to exit
    // and get the exit code
    const exitCode = await closePromise

    // Set the current Steam CMD process to `null` because the process
    // finished running.
    this.#currentSteamCmdProcess = null

    // Cleanup the temp file
    commandFile.cleanup()

    // Throw an error if the exit code was non-zero.
    if (exitCode > 0) {
      // TODO: create nicer error messages. Use the function that was deleted.
      throw new Error(`ERROR ${exitCode}`)
    }
  }

  // TODO: this could be made into a utility function
  getProcessClosePromise (process) {
    return new Promise(resolve => process.on('close', code => resolve(code)))
  }

  // TODO: this function can move to a utility file.
  /**
   * @param chunkIterable An asynchronous or synchronous iterable over "chunks"
   * (arbitrary strings)
   * @returns An asynchronous iterable over "lines" (strings with at most one
   * newline that always appears at the end)
   */
  async * _chunksToLines (chunkIterable) {
    let previous = ''
    for await (const chunk of chunkIterable) {
      // Windows uses CRLF. For consistency we replace it with a plain LF.
      previous += chunk.replace(/\r\n/g, '\n')
      while (true) {
        const eolIndex = previous.indexOf('\n')
        if (eolIndex < 0) break

        const line = previous.slice(0, eolIndex + 1)
        yield line
        previous = previous.slice(eolIndex + 1)
      }
    }

    if (previous.length > 0) {
      yield previous
    }
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
      `login "${this.#username}"`,
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
