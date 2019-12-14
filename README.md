# SteamCMD JavaScript Interface
This library allows you to access
[SteamCMD](https://developer.valvesoftware.com/wiki/SteamCMD) via JavaScript.

This is compatible with Node > v10 on Windows, Linux, or Mac.

# Basic Usage Example
1. Install the package
   ```sh
   npm install steamcmd-interface
   ```

2. Import the class and create a new instance using the `init` function. This
   is an _asynchronous_ function that downloads all the binaries, creates a new 
   instance of SteamCmd, ensures that it can run, and then returns the instance
   ```js
   const { SteamCmd } = require('steamcmd-interface')
   const steamCmd = await SteamCmd.init()
   ```

3. Now you can use the instance to interact with SteamCMD. You can login with
   your user account or anonymously (default), update apps, or run a series of
   commands.

   The `updateApp` function is an async generator that reports on the progress
   of the update as it gets output from the underling SteamCMD process.
   ```js
   // Downloads CS:GO dedicated server to the default install directory.
   for await(const progress of steamCmd.updateApp(740)) {
     // Logs something like "downloading 1.2%"
     console.log(`${progress.state} ${progress.progressPercent}%`)
   }
   ```

# Construction
A new `SteamCmd` object **cannot** be created using the `new` keyword. It will
throw an error. You must use the `SteamCmd.init` async function. This is because
construction is fundamentally asynchronous.

## Options
An options object can be passed to the `SteamCmd.init` function to configure
the behaviour of the instance. These options are available:
- `binDir`: The path to which the SteamCMD binaries will be downloaded to.
  Defaults to "[the module's base directory]/temp/install_dir/[platform string]"
- `installDir`: To where SteamCMD will download all applications. Defaults to
  "[the module's base directory]/temp/install_dir"
- `username`: The user name to log in as. Defaults to "anonymous"

### Examples
- Changing the install directory to install apps to the current working
  directory.
  ```js
  SteamCmd.init({
    installDir: path.join(process.cwd())
  })
  ```
- Setting a user name for downloading purchased games.
  
  **Note** that this will only work if you successfully logged in once and
  SteamCMD has your credentials cached. See the ["Logging In"](#logging-in) 
  section below for more details.
  ```js
  SteamCmd.init({
    username: 'example'
  })
  ```

# Logging In
SteamCmd offers two login-related functions:
- `isLoggedIn` simply tests if the currently saved username is logged in with
  SteamCMD. If this returns true then you can 
- `login`

# Debugging

# Resources
- [SteamCMD home page](https://developer.valvesoftware.com/wiki/SteamCMD)
- [All SteamCMD commands](https://github.com/dgibbs64/SteamCMD-Commands-List)
