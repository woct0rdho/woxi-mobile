// The two "something changed outside this module" notifications shared by the edit,
// history and keyboard code. They are separate from typing.js so history can use them
// without importing the module that imports history.

import { runtime } from "./runtime.js";

export function refreshAssist() {
  if (runtime.assist) runtime.assist.refresh();
}

export function refreshBarState() {
  if (runtime.keyboard) runtime.keyboard.refreshKeyStates();
}
