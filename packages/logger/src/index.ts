import pino, { type LoggerOptions } from "pino";

const isDev = process.env.NODE_ENV !== "production";

export const LOGGER_REDACT_PATHS = [
  "managementKey",
  "*.managementKey",
  "csrfToken",
  "*.csrfToken",
  "req.body",
  "request.body",
  "req.headers.x-settings-csrf",
  "request.headers.x-settings-csrf",
  "res.headers.set-cookie",
  "settingsManagementKey",
  "*.settingsManagementKey",
  "apiKey",
  "credentialEncryptionKey",
  "credentialSecret",
  "password",
  "req.headers.authorization",
  "req.headers.cookie",
  "request.headers.authorization",
  "request.headers.cookie",
  "*.apiKey",
  "*.credentialEncryptionKey",
  "*.credentialSecret",
  "*.password"
] as const;

export function createLoggerOptions(): LoggerOptions {
  return {
    level: process.env.LOG_LEVEL || "info",
    redact: {
      paths: [...LOGGER_REDACT_PATHS],
      censor: "[Redacted]"
    },
    formatters: {
      level: (label) => ({ level: label })
    },
    ...(isDev && {
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname"
        }
      }
    })
  };
}

export const logger = pino(createLoggerOptions());
