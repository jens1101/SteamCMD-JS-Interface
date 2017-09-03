# SteamCMD JS Interface
Allows you to access and use SteamCMD via JavaScript

**Note** this uses ES2017 features, such as async. Please use Node >= 8.3. I
have plans of adding compiled and uglified versions sometime in the future.

## Basic Usage
1. Install the package
```
npm install steamcmd-interface
```
2. Import the class and create a new instance
```javascript
const SteamCmd = require('steamcmd-interface')
const steamcmd = new SteamCmd()
```
3. Now you can use the instance to interact with SteamCMD. Like anonymously
downloading the CS:GO dedicated server
```javascript
// Downloads SteamCMD for the current platform and makes sure that it is usable.
await steamcmd.prep()
// Downloads CS:GO dedicated server to the default install directory.
const runObj = steamcmd.updateApp(740)
```

## Changing the Binary and Install Directories
By default the SteamCMD binaries are downloaded to
`path.join(__dirname, 'steamcmd_bin', process.platform)`. So, for example, this
would equal to: `[Project dir]/node_modules/steamcmd-interface/steamcmd_bin/linux`
on a linux machine.

Similarly the install directory is set to `path.join(__dirname, 'install_dir')`
by default.

It is recommended that you change these defaults, because downloading stuff into
`node_modules` is bad practice. Also, I suspect that these directories may get
deleted when you upgrade or uninstall this package.

You can change these directories by running:
```javascript
// On construction
const steamcmd = new SteamCmd({
  binDir: `~/Downloads/steamcmd/bin`,
  installDir: `~/Downloads/steamcmd/apps`
})
// Or later on via a function call:
steamcmd.setOptions({
  binDir: `~/Downloads/steamcmd/bin`,
  installDir: `~/Downloads/steamcmd/apps`
})
```
**Pro Tip**: If you have the Steam client installed then you can set the install
directory to the [library directory](https://support.steampowered.com/kb_article.php?ref=7418-YUBN-8129)
of the client. This will cause Steam to recognise the app and you won't need to
move files manually.

## Downloading and Updating Apps
You can download or update a steam app by running `updateApp(appId)`. For example:
```javascript
const runObj = steamcmd.updateApp(740)
```
The above will download the CS:GO dedicated server to the default install
directory.

The `updateApp` function returns a `RunObj` object. This contains two properties
`outputStream` and `killSteamCmd`.

`outputStream` is a readable stream that returns the output of SteamCMD line by
line. So if you want to log the output then you can do something like:
```javascript
runObj.outputStream.on('data', data => { console.log(data) })
runObj.outputStream.on('error', err => { console.error(err) })
runObj.outputStream.on('close', exitCode => { console.log(exitCode) })
```
Practically this can be used for things like tracking the download progress of
an app.

`killSteamCmd` is a function that, once called, will kill the SteamCMD process.
This is currently the only way to stop a download. Don't worry, when you try to
update the same app again then it will start the download there where it left
off.

## Setting Your Login Credentials
By default this package uses the anonymous account to login to Steam. You can
change this by running:
```javascript
// On construction
const steamcmd = new SteamCmd({
  username: 'test',
  password: '1234',
  steamGuardCode: 'XG29X'
})
// Or later via a funtion call
steamcmd.setOptions({
  username: 'test',
  password: '1234',
  steamGuardCode: 'XG29X'
})
```
If you do this then you have access to your entire Steam library.

**Note 1** Your Steam Guard code will only get sent to you once you tried to login
via your username and password. So you'll need to do something like this on the
first login to SteamCMD:
```javascript
const steamcmd = new SteamCmd({
  username: 'test',
  password: '1234'
})
await steamcmd.prep()
const runObj = steamcmd.updateApp(740)
runObj.outputStream.on('close', exitCode => {
  if(errorCode === SteamCmd.EXIT_CODES.STEAM_GUARD_CODE_REQUIRED) {
    // At this point SteamCMD ran and failed, because the Steam Guard code was
    // not set. So here you somehow need to provide it with the correct code and
    // it should work.
    steamcmd.setOptions({
      steamGuardCode: '[The code that was sent to you by Steam]'
    })
    // This works now!
    steamcmd.updateApp(740)
  }
})
```

**Note 2** After you have successfully logged in then SteamCMD stores your
credentials internally. So you don't need to specify a Steam Guard code each time.

## Getting an Error Message For an Exit Code
Sometimes you may want to get a human-readable error message for a particular
exit code. In this case simply use `SteamCmd.getErrorMessage`. For example:
```javascript
const runObj = steamcmd.updateApp(740)
runObj.outputStream.on('close', exitCode => {
  if(errorCode !== SteamCmd.EXIT_CODES.NO_ERROR) {
    // Something went wrong, throw an error
    throw new Error(SteamCmd.getErrorMessage(exitCode))
  }
})
```

## Running Custom Commands
It is possible to run your own custom commands using the `run` function. It
expects an array of commands that it will run one after the next. It will quit
the moment an error occurs. For example:
```javascript
const commands = const commands = [
  steamcmd.getLoginStr(),
  `force_install_dir "${steamcmd.installDir}"`,
  'app_uninstall -complete 740'
]
const runObj = steamcmd.run(commands)
```
The above will login using the current credentials, set the install directory
and completely uninstall CS:GO dedicated server.

For a list of all possible commands see
[this wiki entry](https://developer.valvesoftware.com/wiki/Command_Line_Options#SteamCMD)
or [this github repo](https://github.com/dgibbs64/SteamCMD-Commands-List/)

**Note** The run command automatically adds `@ShutdownOnFailedCommand 1` and
`@NoPromptForPassword 1` the the beginning of your list of commands. This is to
prevent the SteamCMD process from hanging. If you want to over-write this then
just add `@ShutdownOnFailedCommand 0` and/or `@NoPromptForPassword 0` to the
beginning of your list of commands.

## TODO
- Add better documentation with jsdoc
- Add automation tasks with something like gulp
- Add more tests
- Add compiled versions that support lesser versions of JS.
- Uglify the final code.
