const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const appDir = path.resolve(__dirname, '..')
const repoDir = path.resolve(appDir, '..')
const runtimeDir = path.join(repoDir, 'nodeAndWorker')

function platformId() {
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'darwin') return `darwin-${arch}`
  if (process.platform === 'win32') return `win32-${arch}`
  if (process.platform === 'linux') return `linux-${arch}`
  return `${process.platform}-${arch}`
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
}

function copyIfPresent(from, to) {
  if (!fs.existsSync(from)) return false
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.copyFileSync(from, to)
  if (process.platform !== 'win32') fs.chmodSync(to, 0o755)
  return true
}

function assertFile(relativePath, executable = false) {
  const filePath = path.join(runtimeDir, relativePath)
  if (!fs.existsSync(filePath)) {
    throw new Error(`runtime file missing: nodeAndWorker/${relativePath}`)
  }
  if (executable && process.platform !== 'win32') {
    fs.chmodSync(filePath, 0o755)
  }
  const stat = fs.statSync(filePath)
  return {
    path: relativePath,
    bytes: stat.size,
    sha256: sha256(filePath),
    executable,
  }
}

const target = platformId()
const exe = process.platform === 'win32' ? 'rust-daemon.exe' : 'rust-daemon'
const compiledDaemon = path.join(runtimeDir, 'target', 'release', exe)
const bundledDaemon = path.join(runtimeDir, 'bin', target, exe)
copyIfPresent(compiledDaemon, bundledDaemon)

const required = [
  assertFile(path.join('bin', target, exe), true),
  assertFile(path.join('python-inference', 'shard_runtime.py')),
  assertFile(path.join('python-inference', 'distributed_llm_orchestrator.py')),
  assertFile(path.join('python-inference', 'requirements.txt')),
  assertFile(path.join('scripts', 'vryx-direct-p2p-diagnostic.sh'), true),
]

const manifest = {
  name: 'vryx-worker-runtime',
  generatedAt: new Date().toISOString(),
  platform: target,
  appVersion: require(path.join(appDir, 'package.json')).version,
  files: required,
}

const manifestPath = path.join(runtimeDir, 'runtime-release-manifest.json')
fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
console.log(`[prepare-runtime] ${required.length} files verified for ${target}`)
console.log(`[prepare-runtime] manifest: ${path.relative(repoDir, manifestPath)}`)
