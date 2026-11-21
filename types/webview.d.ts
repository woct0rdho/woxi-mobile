// The browser globals the native shell installs on `window`. The WebView layer is plain
// JavaScript checked by `tsc --checkJs`. These are the only app-specific globals it needs.
//
// `WoxiNative` is the Android JavaScript interface: a proxy whose methods are invoked
// directly (see `nativeCall` in `runtime.js`), so an index signature is the accurate shape.

export {};

declare global {
  interface Window {
    WoxiNative?: {
      [name: string]: (...args: any[]) => any;
    };
    WoxiNativeCallbacks?: {
      onEngineResult?: (id: number, json: string, token: string) => void;
      onInsets?: (top: number, bottom: number, ime: number) => void;
      onSaveComplete?: (ok: string, name: string, token: string) => void;
      onAutosaveComplete?: (ok: string, name: string, revision: string, token: string) => void;
      onNotebookRenamed?: (
        ok: string,
        oldName: string,
        newName: string,
        message: string,
        token: string
      ) => void;
      onNotebookDeleted?: (ok: string, name: string, message: string, token: string) => void;
      onFileOpened?: (name: string, text: string, token: string, error?: string) => void;
      [name: string]: ((...args: any[]) => void) | undefined;
    };
    WoxiApp?: {
      testAction?: (action: string, argument?: string) => void;
      onNativeBack: () => boolean;
      flushAutosave?: () => void;
    };
  }
}
