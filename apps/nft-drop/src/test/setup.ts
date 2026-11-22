// Node 25+ defines its own localStorage and sessionStorage globals, so vitest
// does not install jsdom's. Use jsdom's storage in jsdom test files.
const dom = (globalThis as { jsdom?: { window: Window } }).jsdom;
if (dom) {
  for (const key of ["localStorage", "sessionStorage"] as const) {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      value: dom.window[key],
    });
  }
}
