const path = require('path')
const fs = require('fs')
const request = require('request')
const _ = require('lodash')
// TODO what does this even do? I would like to remove it because it hasn't been
// updated in 4 years!
const vdf = require('vdf')

// TODO also try to remove unzip, tar, and zlib. They haven't been updated in
// years and I'm sure that a native option exists

const { spawn } = require('child_process')
const stream = require('stream')
const utf8Decoder = new (require('string_decoder').StringDecoder)('utf8')

const defaultOptions = {
  asyncDelay: 3000,
  binDir: path.join(__dirname, 'steamcmd_bin'),
  retries: 3,
  retryDelay: 3000,
  installDir: path.join(__dirname, 'install_dir')
}

// TODO use underscores for private functions
module.exports = class SteamCmd {
  constructor (options) {
    this.options = _.defaults({}, options, defaultOptions)
    this.steamcmdProcess = null
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
          extractor: require('unzip'),
          exeName: 'steamcmd.exe'
        }
        break
      case 'darwin':
        this.platformVars = {
          url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_osx.tar.gz',
          extractor: require('tar'),
          exeName: 'steamcmd.sh'
        }
        break
      case 'linux':
        this.platformVars = {
          url: 'https://steamcdn-a.akamaihd.net/client/installer/steamcmd_linux.tar.gz',
          extractor: require('tar'),
          exeName: 'steamcmd.sh'
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
    return path.join(this.options.binDir, this.platformVars.exeName)
  }

  /**
   * Returns a promise that resolves after ms milliseconds
   */
  static promiseToWait (ms) {
    return new Promise(resolve => setTimeout(resolve, ms))
  }

  /**
   * Takes a func that returns a promise and a set of args to pass it. Returns
   * the promise chained with retries and retry delays.
   */
  static async promiseToRetry (func, ...args) {
    let retries = this.options.retries

    while (retries--) {
      try {
        return await func(...args)
      } catch (e) {
        console.error(`Exception: "${e.message}", retrying, ${retries} retrie(s) left`)
        await SteamCmd.promiseToWait(this.options.retryDelay)
      }
    }

    throw new Error(`Promise failed after ${retries} retries`)
  }

  async download () {
    return new Promise((resolve, reject) => {
      let req = request(this.platformVars.url)
      if (process.platform !== 'win32') {
        req = req.pipe(require('zlib').createGunzip())
      }

      req.pipe(this.platformVars.extractor.Extract({
        path: this.options.binDir
      }).on('finish', resolve).on('error', reject))
    })
  }

  async downloadIfNeeded () {
    return Promise.resolve()
      .then(() => {
        // The file must be accessible and executable
        fs.accessSync(this.exePath, fs.constants.X_OK)
      })
      .then(() => {})
      .catch(() => this.download)
  }

  static get MESSAGE_TYPES () {
    return {
      MESSAGE: 0,
      STEAMCMD_READY: 1,
      LOGGED_IN: 2,
      UPDATING: 3,
      UPDATED: 4
    }
  }

  run (username) {
    // TODO I think a transform stream would be better suited in this case
    let ioStream = new stream.Duplex({
      // TODO should I maybe use a buffer instead and then decode as JS object?
      decodeStrings: false,
      /**
       * Is called whenever the user wants to read the stream. The output of
       * steamcmd is pushed here.
       */
      read () {},
      /**
       * Is called whenever the user writes to this stream.
       * @param {string} chunk The string the user wrote. This is a string because
       * `decodeStrings` is set to `false`.
       * @param {string} enc The encoding of the string.
       * @param {Function} next A callback to call once this function is done.
       * This is required to allow piping.
       */
      write (chunk, enc, next) {
        this.steamcmdProcess.stdin.write(chunk)
        next()
      },
      /**
       * Is called when the stream needs to be forcefully destroyed.
       * @param {Error|null} err The error that caused this stream to be
       * destroyed. `null` means that no error occurred.
       * @param {Function} callback The callback function to call once the stream
       * has been destroyed.
       */
      destroy (err, callback) {
        if (err) {
          // TODO handle the error properly
          console.error(err)
        }
        // TODO stop the steamcmdProcess and call callback
      }
    })

    // TODO download steamCMD first if it doesn't exist yet
    this.steamcmdProcess = spawn(this.exePath)
    let currLine = ''
    this.steamcmdProcess.stdout.on('data', (data) => {
      currLine += utf8Decoder.write(data)
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
        }

        ioStream.push(JSON.stringify(response))
      }

      if (currLine === '') {
        console.warn('CURRENT LINE IS EMPTY!')
      }
    })

    this.steamcmdProcess.stderr.on('data', (data) => {
      console.error(`stderr: ${data}`)
    })

    this.steamcmdProcess.on('close', (code) => {
      // if (code === 0 || code === 7) {
      //   // Steamcmd will occasionally exit with code 7 and be fine.
      //   // This usually happens the first run() after download().
      //   resolve(result)
      // } else {
      //   reject(result)
      // }
      console.log(`child process exited with code ${code}`)
    })

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
    return SteamCmd.promiseToRetry(this.getAppInfoOnce, appID)
  }

  // TODO allow the user to force the platform type
  async updateAppOnce (appId) {
    if (!path.isAbsolute(this.options.installDir)) {
      // throw an error immediately because it's invalid data, not a failure
      throw new TypeError('installDir must be an absolute path in updateApp')
    }

    let commands = [
      '@ShutdownOnFailedCommand 0',
      'login anonymous',
      `force_install_dir ${this.options.installDir}`,
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
    return SteamCmd.promiseToRetry(this.updateAppOnce, appId)
  }

  async prep () {
    await this.downloadIfNeeded()
    await SteamCmd.promiseToWait(500)
    return this.touch()
  }
}
