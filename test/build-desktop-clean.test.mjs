import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, copyFileSync, readFileSync } from 'node:fs'
import { execFileSync, spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Root cause of #96: the script ran `npm install`, which rewrites desktop/package-lock.json. It must use `npm ci`.
test('build-desktop.sh uses npm ci and leaves the checkout clean', () => {
  const root = mkdtempSync(join(tmpdir(), 'bd96-'))
  mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'desktop'))
  copyFileSync('scripts/build-desktop.sh', join(root, 'scripts/build-desktop.sh'))
  writeFileSync(join(root, 'desktop/package.json'), '{"name":"x","version":"1.0.0"}\n')
  writeFileSync(join(root, 'desktop/package-lock.json'), '{"lockfileVersion":3}\n')
  writeFileSync(join(root, '.gitignore'), 'desktop/dist/\ndesktop/node_modules/\n')
  // Fake npm: `install` rewrites the lockfile (as real npm may); `ci` leaves it alone; `run dist` makes artifacts.
  const cli = join(root, 'fake-npm.js')
  writeFileSync(cli, `
const fs = require('fs'); const a = process.argv.slice(2)
fs.appendFileSync(${JSON.stringify(join(root, 'calls.log'))}, a.join(' ') + '\\n')
if (a[0] === '-v') console.log('0.0.0')
else if (a[0] === 'install') fs.writeFileSync('package-lock.json', '{"lockfileVersion":3,"rewritten":true}\\n')
else if (a[0] === 'run') { fs.mkdirSync('dist', { recursive: true }); for (const f of ['a.exe', 'a.exe.blockmap', 'latest.yml']) fs.writeFileSync('dist/' + f, 'x') }
`)
  const git = (...a) => execFileSync('git', a, { cwd: root, encoding: 'utf8' })
  git('init', '-q'); git('add', '-A')
  git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init')
  const r = spawnSync('bash', [join(root, 'scripts/build-desktop.sh')], { cwd: root, encoding: 'utf8', env: { ...process.env, NPM_CLI: cli } })
  assert.equal(r.status, 0, r.stderr)
  const calls = readFileSync(join(root, 'calls.log'), 'utf8')
  assert.match(calls, /^ci /m)
  assert.doesNotMatch(calls, /^install/m)
  assert.equal(git('status', '--porcelain').replace(/^\?\? calls\.log\n|^\?\? fake-npm\.js\n/gm, ''), '')
})
