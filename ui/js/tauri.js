// Thin wrapper around the Tauri global so the UI still loads in a plain browser.
const globalTauri = typeof window !== 'undefined' ? window.__TAURI__ : null;

export const hasTauri = Boolean(globalTauri && globalTauri.core && globalTauri.core.invoke);

export async function invoke(command, args = {}) {
  if (!hasTauri) throw new Error(`Tauri command "${command}" is unavailable in a browser`);
  return globalTauri.core.invoke(command, args);
}

export function convertFileSrc(path) {
  if (hasTauri && globalTauri.core.convertFileSrc) return globalTauri.core.convertFileSrc(path);
  return path;
}

export async function listen(event, handler) {
  if (!hasTauri || !globalTauri.event) return () => {};
  return globalTauri.event.listen(event, handler);
}

export function appWindow() {
  return hasTauri && globalTauri.window ? globalTauri.window.getCurrentWindow() : null;
}
