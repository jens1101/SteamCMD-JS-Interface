import { createWriteStream, constants } from 'fs'
import { access, mkdir, chmod, appendFile } from 'fs/promises'
import { dirname, join, isAbsolute } from 'path'
import { fileURLToPath } from 'url'
import axios from 'axios'
import pty from 'node-pty'
import { file } from 'tmp-promise'
import { getPtyDataIterator, getPtyExitPromise } from './lib/nodePtyUtils'
import { extractArchive } from './lib/extractArchive'
import { SteamCmdError } from './SteamCmdError'

const currentDirectory = dirname(fileURLToPath(import.meta.url))

/**
 * A progress update on an app update. This typically reports how much of an
 * app has been downloaded so far, however this isn't it's only use case. An
 * app update consists of multiple stages, including: pre-allocating space,
 * downloading, verification, etc.
 * @typedef {Object} SteamCmd~UpdateProgress
 * @property {string} stateCode The current state's code. This seems to be used
 * internally as a sort of unique ID.
 * @property {string} state The human-readable version of the current state.
 * @property {number} progressPercent The percentage of how much of the current
 * state has been completed.
 * @property {number} progressAmount The actual amount of work that has been
 * completed for the current state. This is used to calculate the progress
 * percentage. What unit this is in depends on the current state.
 * @property {number} progressTotalAmount The total amount of work that must be
 * completed for the current state. This is used to calculate the progress
 * percentage. What unit this is in depends on the current state.
 */

/**
 * This class acts as an intermediate layer between SteamCMD and NodeJS. It
 * allows you to download the SteamCMD binaries, login with a custom user
 * account, update an app, etc.
 */
export class SteamCmd {
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
   * @type {IPty|null}
   */
  #currentSteamCmdPty = null

  /**
   * Whether or not all the output of the `run` command will be logged to the
   * console. Useful for debugging.
   * @type {boolean}
   * @see SteamCmd.run
   */
  enableDebugLogging = false

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
   * @throws {Error} Throws an error if called directly
   * @throws {Error} Throws an error if the specified platform is not supported
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

    // Kill the current pseudo terminal if this process is being terminated
    process.once('exit', () => this.cleanup())
  }

  /**
   * Returns the currently running Steam CMD process. This can be used to
   * forcefully kill the process if something goes wrong. If no Steam CMD
   * process is running then this returns `null` instead.
   * @returns {IPty|null}
   */
  get currSteamCmdProcess () {
    return this.#currentSteamCmdPty
  }

  /**
   * A publicly accessible getter to get the Steam CMD executable
   * @type {string}
   */
  get exePath () {
    return join(this.#binDir, this.#exeName)
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
   * executable will be downloaded to. Defaults to "temp/steamcmd_bin" in the
   * current directory.
   * @param {string} [options.installDir] The absolute path to where Steam apps
   * will be installed to. Defaults to "temp/install_dir" in the current
   * directory.
   * @param {string} [options.username='anonymous'] The username to log into
   * Steam.
   * @param {boolean} [options.enableDebugLogging = false] Whether or not all
   * output of Steam CMD will be logged to the console. This is useful for
   * debugging.
   * @returns {Promise<SteamCmd>} Resolves into a ready-to-be-used SteamCmd
   * instance
   */
  static async init ({
    binDir = join(currentDirectory, '../temp', 'steamcmd_bin',
      process.platform),
    installDir = join(currentDirectory, '../temp', 'install_dir'),
    username = 'anonymous',
    enableDebugLogging = false
  } = {}) {
    // Set the `initialising` variable to true to indicate to the constructor
    // that it's being legally called.
    SteamCmd.#initialising = true

    // Construct the new SteamCmd instance
    const steamCmd = new SteamCmd(binDir, installDir, username)

    steamCmd.enableDebugLogging = enableDebugLogging

    // Download the Steam CMD executable
    await steamCmd.downloadSteamCmd()

    // Test that the executable is in working condition
    // eslint-disable-next-line no-unused-vars
    for await (const line of steamCmd.run([], {
      noAutoLogin: true
    })) {
      // eslint-disable-next-line no-empty
    }

    // Finally return the ready-to-be-used instance
    return steamCmd
  }

  /**
   * Cleans up all the resources associated with this instance
   */
  cleanup () {
    if (this.#currentSteamCmdPty) this.#currentSteamCmdPty.kill()

    this.#currentSteamCmdPty = null
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
   * @throws {SteamCmdError} An error if the login failed in any way.
   */
  async login (username, password, steamGuardCode) {
    // Build the login command from the given credentials
    const loginCommand = ['login', `"${username}"`]
    if (password) loginCommand.push(`"${password}"`)
    if (steamGuardCode) loginCommand.push(`"${steamGuardCode}"`)

    // Run the login command. This will throw an error if the login was
    // unsuccessful.
    // eslint-disable-next-line no-unused-vars
    for await (const line of this.run([loginCommand.join(' ')], {
      noAutoLogin: true
    })) {
      // eslint-disable-next-line no-empty
    }

    // If the login succeeded then update the currently saved username.
    this.#username = username
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
   * Download the SteamCMD binaries if they are not installed in the current
   * install directory. Does nothing if the binaries have already been
   * downloaded.
   * @returns {Promise<void>} Resolves once the binaries have been downloaded.
   * @throws {Error} Throws an error if the SteamCMD executable was not found
   * in the bin directory.
   */
  async downloadSteamCmd () {
    // Try to access the Steam CMD file as an executable. If this doesn't throw
    // an error then we know that is has already been downloaded and we can
    // return.
    try {
      await access(this.exePath, constants.X_OK)
      return
    } catch {}

    // If this part is reached then we need to download the executable.

    // Create the bin directory if need be
    await mkdir(this.#binDir, { recursive: true })

    // Create a temp file into which the archive will be downloaded
    const tempFile = await file()
    try {
      // Download the archive and stream it into the temp file
      const responseStream = await axios.get(this.#downloadUrl, {
        responseType: 'stream'
      })

      const tempFileWriteStream = createWriteStream(tempFile.path)

      responseStream.data.pipe(tempFileWriteStream)
      await new Promise(resolve => {
        tempFileWriteStream.on('finish', resolve)
      })

      // Extract the Steam CMD executable from the archive
      await extractArchive(tempFile.path, this.#binDir)
    } finally {
      // Cleanup the temp file
      await tempFile.cleanup()
    }

    try {
      // Automatically set the correct file permissions for the executable
      await chmod(this.exePath, 0o755)
    } catch (error) {
      // If the executable's permissions couldn't be set then throw an error.
      throw new Error('Steam CMD executable\'s permissions could not be set')
    }

    try {
      // Test if the file is accessible and executable
      await access(this.exePath, constants.X_OK)
    } catch (ex) {
      // If the Steam CMD executable couldn't be accessed as an executable
      // then throw an error.
      throw new Error('Steam CMD executable cannot be run')
    }
  }

  /**
   * This generator runs the array of commands that you pass to it. It creates
   * a temporary file, writes the commands to it, and the runs it as a script
   * via the Steam CMD executable. It asynchronously yields each line of output
   * from the executable. Note that this will not actually run until the first
   * value has been requested. Therefore this will mostly be run within a
   * `for await of` loop.
   *
   * A list of all Steam CMD commands can be found here:
   * https://github.com/dgibbs64/SteamCMD-Commands-List/blob/master/steamcmd_commands.txt
   *
   * The following commands will be prepended to the given array of commands:
   *
   * - `@ShutdownOnFailedCommand 1`: This ensures that the executable will quit
   *   the moment it encounters an error
   * - `@NoPromptForPassword 1`: This ensures that the executable will not
   *   prompt for a password on login (since that could suspend the process
   *   indefinitely).
   * - `login [username]`: This logs in the currently saved user
   *
   * The following commands will be appended to the given array of commands:
   *
   * - `quit`: This ensures that Steam CMD will always quit once the script
   *   file has been run successfully. This ensures that the process will not
   *   hang once the script has been executed.
   *
   * The behaviour of this function can be customised via the `options`
   * parameter.
   * @param {string[]} commands An array of commands that must be executed via
   * Steam CMD
   * @param {Object} [options] Options to change the behaviour of the run
   * command.
   * @param {boolean} [options.noAutoLogin=false] Whether or not to
   * automatically append the `login` command to the given array of commands.
   * @yields {string} Each line of output from the Steam CMD executable until
   * it terminates.
   * @throws {SteamCmdError} Throws an error if the Steam CMD executable quit
   * with a non-zero exit code.
   */
  async * run (
    commands,
    {
      noAutoLogin = false
    } = {}
  ) {
    const allCommands = [
      '@ShutdownOnFailedCommand 1',
      '@NoPromptForPassword 1',
      noAutoLogin ? '' : `login "${this.#username}"`,
      ...commands,
      'quit'
    ]

    // Create a temporary file that will hold our commands
    const commandFile = await file()

    try {
      await appendFile(commandFile.path,
        allCommands.join('\n') + '\n')

      // Spawn Steam CMD as a process
      const steamCmdPty = pty.spawn(this.exePath, [
        `+runscript ${commandFile.path}`
      ], {
        cwd: currentDirectory
      })

      this.#currentSteamCmdPty = steamCmdPty

      // Create a promise that will resolve once the Steam CMD process closed.
      const exitPromise = getPtyExitPromise(steamCmdPty)

      // Convert the chunks to lines and then iterate over them.
      for await (const outputLine of getPtyDataIterator(steamCmdPty)) {
        if (this.enableDebugLogging) console.log(outputLine)
        yield outputLine
      }

      // Once the output has been iterated over then wait for the process to
      // exit and get the exit code
      const exitCode = await exitPromise

      // Set the current Steam CMD process to `null` because the process
      // finished running.
      this.#currentSteamCmdPty = null

      // Throw an error if Steam CMD quit abnormally
      if (exitCode !== SteamCmdError.EXIT_CODES.NO_ERROR &&
        exitCode !== SteamCmdError.EXIT_CODES.INITIALIZED) {
        throw new SteamCmdError(exitCode)
      }
    } finally {
      // Always cleanup the temp file
      await commandFile.cleanup()
    }
  }

  /**
   * Downloads or updates the specified Steam app. If this app has been
   * partially downloaded in the current install directory then this will
   * simply continue that download process.
   * @param {number} appId The ID of the app to download.
   * @param {Object} [options]
   * @param {string} [options.platformType] The platform type of the app that
   * you want to download. If omitted then this will use the current platform.
   * Must be one of "windows", "macos", or "linux".
   * @param {number} [options.platformBitness] Indicates the bitness of the
   * platform. Can be either 32 or 64. If omitted then this will use the current
   * platform's bitness.
   * @param {boolean} [options.validate=false] Whether or not to validate the
   * files after download.
   * @param [options.language] The language in which to download the app.
   * @param [options.betaName] Used to download a beta branch of an app. Specify
   * the name of the branch that you want to download, e.g.: "prerelease",
   * "beta", etc. If omitted will download the publicly available app.
   * @param [options.betaPassword] The password for downloading the beta branch
   * (if applicable).
   * @yields {SteamCmd~UpdateProgress} Progress updates while the app is being
   * updated.
   * @throws {SteamCmdError} Throws an error if the Steam CMD executable quit
   * with a non-zero exit code.
   * @throws {TypeError} Throws an error if the install directory is a relative
   * path. It must be absolute, because SteamCMD doesn't support relative
   * install directories.
   */
  async * updateApp (
    appId,
    {
      platformType,
      platformBitness,
      validate = false,
      language,
      betaName,
      betaPassword
    } = {}
  ) {
    if (!isAbsolute(this.#installDir)) {
      // throw an error immediately because SteamCMD doesn't support relative
      // install directories.
      throw new TypeError(
        'installDir must be an absolute path to update an app')
    }

    // Create the install directory if need be
    await mkdir(this.#installDir, { recursive: true })

    const appUpdateCommand = [`app_update ${appId}`]
    validate && appUpdateCommand.push('-validate')
    language && appUpdateCommand.push(`-language ${language}`)
    betaName && appUpdateCommand.push(`-beta ${betaName}`)
    betaPassword && appUpdateCommand.push(`-betapassword ${betaPassword}`)

    const commands = [
      `force_install_dir "${this.#installDir}"`,
      appUpdateCommand.join(' ')
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

    /**
     * This regular expression tests each line of output from Steam CMD. It
     * will match the patten that is emitted when the current app is being
     * downloaded.
     * @type {RegExp}
     */
    const progressRegex =
      /Update state \((0x\d+)\) (\w+), progress: (\d+.\d+) \((\d+) \/ (\d+)\)$/

    for await (const line of this.run(commands)) {
      // Test the current line of output
      const result = progressRegex.exec(line)

      // If the current line doesn't match the Regex pattern then it's skipped.
      if (result == null) continue

      // If the pattern matched then we assign each one of the capture groups to
      // a variable
      const [
        stateCode,
        state,
        progressPercent,
        progressAmount,
        progressTotalAmount
      ] = result.slice(1)

      // Return the variables as an object.
      yield {
        stateCode,
        state,
        progressPercent: parseFloat(progressPercent),
        progressAmount: parseInt(progressAmount),
        progressTotalAmount: parseInt(progressTotalAmount)
      }
    }
  }
}
