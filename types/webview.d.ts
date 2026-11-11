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
      onEngineResult?: (id: number, json: string) => void;
      onInsets?: (top: number, bottom: number) => void;
      onFileOpened?: (name: string, base64: string) => void;
      [name: string]: ((...args: any[]) => void) | undefined;
    };
    WoxiApp?: {
      testAction: (action: string, argument?: string) => void;
      onNativeBack: () => boolean;
    };
  }
}
