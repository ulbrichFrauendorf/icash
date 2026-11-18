module.exports = {
  // The encrypted SQLite driver ships platform Node-API binaries shared by Node and Electron.
  rebuildConfig: { onlyModules: [] },
  packagerConfig: {
    asar: true,
    ignore: /^\/(?!dist(?:\/|$)|node_modules(?:\/|$)|package\.json$)/,
  },
  makers: [
    { name: '@electron-forge/maker-squirrel', platforms: ['win32'], config: { name: 'iCash' } },
    { name: '@electron-forge/maker-zip', platforms: ['win32', 'linux', 'darwin'] },
  ],
  plugins: [{ name: '@electron-forge/plugin-auto-unpack-natives', config: {} }],
};
