const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

module.exports = async function cleanXattrs(context) {
  if (context.electronPlatformName === 'win32') {
    const runtimeRoot = path.join(context.appOutDir, 'resources', 'nodeAndWorker')
    const launcher = path.join(runtimeRoot, 'start-worker.bat')
    const isArm64 = path.basename(context.appOutDir).includes('arm64')
    const daemon = path.join(runtimeRoot, 'bin', isArm64 ? 'win32-arm64' : 'win32-x64', 'rust-daemon.exe')
    if (!fs.existsSync(launcher)) {
      throw new Error(`Windows worker launcher manquant dans le package: ${launcher}`)
    }
    if (!fs.existsSync(daemon)) {
      throw new Error(`Windows rust-daemon manquant dans le package: ${daemon}`)
    }
    return
  }
  if (context.electronPlatformName !== 'darwin') return
  try {
    execFileSync('/usr/bin/xattr', ['-cr', context.appOutDir], { stdio: 'ignore' })
  } catch {
    // Best-effort cleanup. Codesign will surface any remaining macOS metadata issue.
  }
  try {
    execFileSync('/usr/bin/find', [context.appOutDir, '-name', '._*', '-delete'], { stdio: 'ignore' })
  } catch {
    // Best-effort cleanup.
  }
  for (const attr of ['com.apple.provenance', 'com.apple.FinderInfo', 'com.apple.fileprovider.fpfs#P']) {
    try {
      execFileSync('/usr/bin/find', [context.appOutDir, '-exec', '/usr/bin/xattr', '-d', attr, '{}', ';'], {
        stdio: 'ignore',
      })
    } catch {
      // Best-effort cleanup.
    }
  }
}
