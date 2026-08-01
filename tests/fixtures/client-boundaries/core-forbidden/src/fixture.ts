import { readFile } from "node:fs/promises";
import { createRoot } from "react-dom/client";

export const forbiddenDependencies = [
  fetch,
  EventSource,
  localStorage,
  document,
  window,
  readFile,
  createRoot
];
