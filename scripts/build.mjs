// Builds every artifact of the plugin into lib/:
//   index.js      – node half (ESM), loaded by the DSH host
//   client.js     – in-app browser half, wrapped in the DSH web loader handoff
//                   window.__ModuleLoader__.load({ id, factory: (require) => module.exports })
//   overlay.js/.html – desktop overlay page, served to the native helper
//   whale-overlay(.exe) – native helper: macOS (swiftc) or Windows (dotnet, skipped when unavailable)
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { copyFile, mkdir, readFile, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

process.chdir(fileURLToPath(new URL('..', import.meta.url)))   // repo root (Windows-safe)
const pkg = JSON.parse(await readFile('package.json', 'utf8'))
const id = pkg.name
await mkdir('lib', { recursive: true })

await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  external: ['@deepseek-ai/*'],
})

const browser = { bundle: true, platform: 'browser', target: 'es2022', loader: { '.css': 'text' } }

await build({
  ...browser,
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  format: 'cjs',
  sourcemap: 'inline',
  banner: { js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\nvar module = { exports: {} }; var exports = module.exports;` },
  footer: { js: 'return module.exports; } });' },
})

await build({ ...browser, entryPoints: ['src/overlay/main.ts'], outfile: 'lib/overlay.js', format: 'iife' })
await copyFile('src/overlay/overlay.html', 'lib/overlay.html')

if (process.platform === 'darwin') {
  try {
    execFileSync('swiftc', ['-O', '-swift-version', '5', 'native/macos/WhaleOverlay.swift', '-o', 'lib/whale-overlay'], { stdio: 'inherit' })
  } catch {
    console.warn('swiftc unavailable: skipping the desktop overlay helper (the whale stays inside the DSH window)')
  }
}

// Windows overlay helper: .NET Framework 4.8 (present on every Windows 10/11) + the WebView2 runtime.
// Building it needs the .NET SDK; without one the whale simply stays inside the DSH window.
if (process.platform === 'win32') {
  const out = 'native/windows/out'
  const needed = ['whale-overlay.exe', 'whale-overlay.exe.config', 'Microsoft.Web.WebView2.Core.dll', 'WebView2Loader.dll']
  try {
    execFileSync('dotnet', ['build', 'native/windows/WhaleOverlay.csproj', '-c', 'Release', '-o', out, '--nologo', '-v', 'minimal'], { stdio: 'inherit' })
  } catch (error) {
    console.warn(error?.code === 'ENOENT'
      ? 'dotnet SDK not found: skipping the Windows overlay helper (the whale stays inside the DSH window)'
      : 'the Windows overlay helper did not build: skipping it (the whale stays inside the DSH window)')
  }
  for (const file of needed) {
    try {
      await copyFile(`${out}/${file}`, `lib/${file}`)
    } catch {
      if (file === 'whale-overlay.exe') {
        console.warn('could not replace lib/whale-overlay.exe — quit DeepSeek Harness (and any running overlay) and build again')
      }
    }
  }
  await rm(out, { recursive: true, force: true })
}

console.log('built lib/')
