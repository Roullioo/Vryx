const { execFileSync } = require('node:child_process')

module.exports = async function cleanXattrs(context) {
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
