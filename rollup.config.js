import babel from '@rollup/plugin-babel'
import pkg from './package.json'

export default [
  {
    input: 'src/SteamCmd.js',
    output: [
      { file: pkg.main, format: 'es' }
    ],
    plugins: [
      babel({
        babelHelpers: 'bundled',
        exclude: ['node_modules/**']
      })
    ],
    external: [
      'axios',
      'extract-zip',
      'file-type',
      'fs',
      'fs/promises',
      'node-pty',
      'path',
      'strip-ansi',
      'tar',
      'tmp-promise',
      'url'
    ]
  }
]
