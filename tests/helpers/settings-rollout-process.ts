// Windows does not deliver a graceful SIGTERM to child processes. Trigger the
// same production signal handler through IPC and keep stdout free for runtime logs.
process.once("message", message => {
  if (message === "stop") process.emit("SIGTERM");
});
try {
  await import("../../services/runtime/src/main.js");
} catch (error) {
  const message = error instanceof Error ? error.message : "unknown startup error";
  process.send?.({ startupError: message.replace(/postgres(?:ql)?:\/\/[^\s]+/gi, "[database]") });
  process.exitCode = 1;
}
process.disconnect?.();
