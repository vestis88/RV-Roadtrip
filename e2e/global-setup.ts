import { execSync, spawn } from 'node:child_process'

function killStrayEmulators() {
  for (const pattern of [
    'cloud-firestore-emulator',
    'firebase-tools/lib/emulator',
  ]) {
    try {
      execSync(`pkill -9 -f "${pattern}"`)
    } catch {
      // nothing matched, that's fine
    }
  }
}

export default async function globalSetup() {
  killStrayEmulators()

  const child = spawn(
    'firebase',
    [
      'emulators:start',
      '--project',
      'demo-rv-trip-planner',
      '--only',
      'firestore,auth,functions',
    ],
    { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
  )

  await new Promise<void>((resolve, reject) => {
    let output = ''
    const timeout = setTimeout(() => {
      reject(new Error(`Timed out waiting for emulators to start.\n${output}`))
    }, 90_000)

    function onData(chunk: Buffer) {
      const text = chunk.toString()
      output += text
      process.stdout.write(`[emulators] ${text}`)
      if (text.includes('Loaded functions definitions from source')) {
        clearTimeout(timeout)
        resolve()
      }
    }

    child.stdout?.on('data', onData)
    child.stderr?.on('data', onData)
    child.on('error', reject)
    child.on('exit', (code) => {
      if (code !== 0) {
        clearTimeout(timeout)
        reject(new Error(`Emulators exited early with code ${code}.\n${output}`))
      }
    })
  })

  return async () => {
    if (child.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL')
      } catch {
        // already dead
      }
    }
    killStrayEmulators()
  }
}
