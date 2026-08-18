// ============================================
// FILE: util/log.js (hardened)
// ============================================

let winston;
try {
  // Do NOT crash if winston isn't installed
  // We’ll fall back to console-only logging.
  // eslint-disable-next-line global-require
  winston = require('winston');
} catch (_) {
  winston = null;
}

const fs = require('fs');
const path = require('path');

// ---------------------------
// Resolve a stable log folder
// ---------------------------
function resolveLogDir() {
  const home = process.env.HOME || process.env.USERPROFILE || process.cwd();
  // Keep logs alongside other app data
  const dir = path.join(home, 'Documents', 'Connect-Ability');
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (_) {
    // Last-ditch fallback
    return process.cwd();
  }
  return dir;
}

const LOG_DIR = resolveLogDir();
const LOG_FILE = path.join(LOG_DIR, 'automation.log');

// ---------------------------
// Error serialization helper
// ---------------------------
function serializeError(err) {
  if (!err) return null;
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack
    };
  }
  if (typeof err === 'object') {
    // avoid circular structures
    try {
      JSON.stringify(err);
      return err;
    } catch {
      return { message: String(err) };
    }
  }
  return { message: String(err) };
}

// ---------------------------
// Data stringify (safe)
// ---------------------------
function safeStringify(obj) {
  if (obj == null) return '';
  try {
    return JSON.stringify(obj);
  } catch {
    return String(obj);
  }
}

// ---------------------------
// Build logger (or console)
// ---------------------------
const level = (process.env.LOG_LEVEL || (process.env.DEBUG === 'true' ? 'debug' : 'info')).toLowerCase();

let logger;

if (winston) {
  const consoleFormat = winston.format.printf(({ level: lvl, message, timestamp, ...meta }) => {
    const ts = timestamp || new Date().toISOString();
    const extra = Object.keys(meta).length ? ` ${safeStringify(meta)}` : '';
    return `[${ts}] ${lvl.toUpperCase()} ${message}${extra}`;
  });

  const colorizer = winston.format.colorize();

  logger = winston.createLogger({
    level,
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true })
    ),
    transports: [
      // Pretty console with colors
      new winston.transports.Console({
        level,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.printf(info => colorizer.colorize(info.level, consoleFormat.transform(info).message))
        )
      }),
      // JSON file for machines
      new winston.transports.File({
        level,
        filename: LOG_FILE,
        maxsize: 5 * 1024 * 1024, // 5MB
        maxFiles: 5,
        tailable: true,
        format: winston.format.combine(
          winston.format.timestamp(),
          winston.format.json()
        )
      })
    ],
    exitOnError: false
  });
} else {
  // Minimal console-only shim
  logger = {
    level,
    info: (msg, meta) => console.log(`[${new Date().toISOString()}] INFO ${msg}`, meta || ''),
    warn: (msg, meta) => console.warn(`[${new Date().toISOString()}] WARN ${msg}`, meta || ''),
    error: (msg, meta) => console.error(`[${new Date().toISOString()}] ERROR ${msg}`, meta || ''),
    debug: (msg, meta) => console.debug(`[${new Date().toISOString()}] DEBUG ${msg}`, meta || '')
  };
}

// ---------------------------
// Public API
// ---------------------------
function logAction(message, data = null) {
  // Console + file (via logger)
  logger.info(message, data ? { data } : undefined);
}

function logWarning(message, data = null) {
  logger.warn(message, data ? { data } : undefined);
}

function logError(message, error = null, extra = null) {
  const err = serializeError(error);
  const meta = { ...(extra ? { extra } : {}), ...(err ? { error: err } : {}) };
  logger.error(message, meta);
}

// Optional: expose stream for morgan, etc.
logger.stream = {
  write: (msg) => logger.info(msg.trim())
};

module.exports = {
  logAction,
  logError,
  logWarning,
  logger,
  LOG_DIR,
  LOG_FILE
};
