const { join } = require('node:path');
const branding = join(__dirname, 'src/app/renderer/assets/branding/invensys.ico');

module.exports = {
  // The encrypted SQLite driver ships platform Node-API binaries shared by Node and Electron.
  rebuildConfig: { onlyModules: [] },
  packagerConfig: {
    asar: true,
    ...(process.platform === 'win32' ? { icon: branding } : {}),
    ignore: /^\/(?!dist(?:\/|$)|node_modules(?:\/|$)|package\.json$)/,
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { name: 'iCash', setupIcon: branding } },
    { name: '@electron-forge/maker-zip', platforms: ['win32', 'linux', 'darwin'] },
  ],
  plugins: [{ name: '@electron-forge/plugin-auto-unpack-natives', config: {} }],
};
