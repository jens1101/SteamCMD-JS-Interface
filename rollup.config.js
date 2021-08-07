import babel from '@rollup/plugin-babel'
import pkg from './package.json'

export default [
  {
    input: 'src/SteamCmd.js',
    output: [
      { file: pkg.main, format: 'cjs' },
      { file: pkg.module, format: 'es' }
    ],
    plugins: [
      babel({
        babelHelpers: 'bundled',
        exclude: ['node_modules/**']
      })
    ],
    external: [
      'path',
      'fs',
      'tmp-promise',
      'axios',
      'node-pty',
      'file-type',
      'extract-zip',
      'tar',
      'strip-ansi'
    ]
  }
]
