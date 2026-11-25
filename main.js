import { cmd, run } from './lib.js'

run(process.env).then(
  (code) => {
    process.exitCode = code
  },
  (e) => {
    console.log(cmd('error', e instanceof Error ? e.message : String(e)))
    process.exitCode = 1
  },
)
