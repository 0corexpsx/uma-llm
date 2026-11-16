const bridge = window.uma;

if (!bridge) {
  // Helpful during plain-browser UI work; the desktop app always injects the real bridge.
  console.warn('Uma preload bridge is unavailable. Launch the Electron app for full functionality.');
}

export const api = bridge;
export default api;
