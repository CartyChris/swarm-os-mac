/*
 * Hands the page its pairing with the built-in bridge. The main process only
 * answers for the app's own origin, so any other page shown in the window
 * (the OpenRouter sign-in, briefly) gets nothing.
 */
const { contextBridge, ipcRenderer } = require("electron");

const native = ipcRenderer.sendSync("swarm:native");
if (native) contextBridge.exposeInMainWorld("swarmNative", Object.freeze(native));
