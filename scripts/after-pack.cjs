/**
 * electron-builder afterPack hook: flip the Electron fuses (SECURITY.md §5.2).
 * These are hard-disabled capabilities baked into the packaged binary —
 * runAsNode and NODE_OPTIONS are the classic local-escalation vectors.
 */
const { flipFuses, FuseVersion, FuseV1Options } = require('@electron/fuses')
const path = require('node:path')

module.exports = async function afterPack(context) {
  const exe = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`)
  await flipFuses(exe, {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
    // EnableEmbeddedAsarIntegrityValidation requires the packager to embed the
    // asar hash in the exe resources; verifying builder support is pending, so
    // OFF for now (M-017) - a silently-unbootable app is worse than one fewer fuse.
    // Revisit: electron-builder win asar integrity support.
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: false,
    [FuseV1Options.EnableCookieEncryption]: true,
  })
  console.log('  • electron fuses flipped (runAsNode off, asar integrity on)')
}
