import babel from '@rollup/plugin-babel'

export default [
  {
    input: 'src/SteamCmd.js',
    output: [
      { file: 'dist/steam-cmd.js', format: 'es' }
    ],
    plugins: [
      babel({
        babelHelpers: 'bundled',
        exclude: ['node_modules/**']
      })
    ],
    external: [
      'node:fs',
      'node:fs/promises',
      'node:path',
      'node:url',
      'axios',
      'node-pty',
      'tmp-promise',
      'file-type',
      'extract-zip',
      'tar',
      'strip-ansi'
    ]
  }
]
