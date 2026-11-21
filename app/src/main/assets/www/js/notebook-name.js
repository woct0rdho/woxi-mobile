// Notebook file names and labels.
//
// The file name is the notebook title. Keeping the display and suggestion rules in one
// small module avoids two modules disagreeing about the extension or the default notebook.

const EXTENSION = ".ipynb";
const DEFAULT_NAME = "Untitled.ipynb";
// 60 four-byte code points plus `.ipynb` and the native `.new` suffix stay below the
// 255-byte filename-component limit. The native side enforces the byte budget.
const MAX_SUGGESTED_TITLE_CHARS = 60;

function suggestFileName(title) {
  let base = (title || "Untitled")
    .trim()
    .replace(/\.ipynb$/i, "")
    .replace(/[\\/:*?"<>|]+/g, "")
    .trim();
  base = base || "Untitled";
  const characters = Array.from(base);
  if (characters.length > MAX_SUGGESTED_TITLE_CHARS) {
    base = characters.slice(0, MAX_SUGGESTED_TITLE_CHARS).join("");
  }
  return base + EXTENSION;
}

function displayTitle(fileName) {
  return String(fileName || "").replace(/\.ipynb$/i, "") || "Untitled";
}

export { DEFAULT_NAME, displayTitle, suggestFileName };
