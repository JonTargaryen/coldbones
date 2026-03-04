import '@testing-library/jest-dom'

// jsdom 28.x localStorage compatibility shim
// jsdom 28 uses origin-keyed storage; when no URL origin is set the native
// implementation may be missing .clear(). Provide a reliable in-memory shim
// so tests can call localStorage.clear() without worrying about jsdom version.
const _store: Record<string, string> = {}
const localStorageMock: Storage = {
  length: 0,
  key:        (i)       => Object.keys(_store)[i] ?? null,
  getItem:    (k)       => _store[k] ?? null,
  setItem:    (k, v)    => { _store[k] = String(v) },
  removeItem: (k)       => { delete _store[k] },
  clear:      ()        => { Object.keys(_store).forEach(k => delete _store[k]) },
}
Object.defineProperty(window, 'localStorage', {
  value: localStorageMock,
  writable: true,
})
