import fs from 'fs/promises';
import path from 'path';

const LOG_LEVELS = { debug: 0, info: 1, warn: 2, error: 3 };
const MIN_LEVEL  = LOG_LEVELS[process.env.LOG_LEVEL?.toLowerCase()] ?? LOG_LEVELS.info;

const COLOURS = {
  debug: '\x1b[36m',   // cyan
  info:  '\x1b[32m',   // green
  warn:  '\x1b[33m',   // yellow
  error: '\x1b[31m',   // red
  reset: '\x1b[0m'
};

export class Logger {
  /**
   * Log a message to console and append to logs/trading.log.
   * @param {string} message
   * @param {'debug'|'info'|'warn'|'error'} type
   */
  static async log(message, type = 'info') {
    const level = LOG_LEVELS[type] ?? LOG_LEVELS.info;
    if (level < MIN_LEVEL) return;

    const timestamp = new Date().toISOString();
    const tag       = type.toUpperCase().padEnd(5);
    const logEntry  = `[${timestamp}] [${tag}] ${message}\n`;

    // Console with colour
    const colour = COLOURS[type] ?? COLOURS.info;
    console.log(`${colour}[${tag}]${COLOURS.reset} ${message}`);

    // File append (best-effort)
    try {
      const logDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logDir, { recursive: true });
      await fs.appendFile(path.join(logDir, 'trading.log'), logEntry);
    } catch { /* never crash on logging */ }
  }

  static debug(msg)   { return Logger.log(msg, 'debug'); }
  static info(msg)    { return Logger.log(msg, 'info');  }
  static warn(msg)    { return Logger.log(msg, 'warn');  }
  static error(msg)   { return Logger.log(msg, 'error'); }

  /**
   * Log a structured JSON object (pretty-printed to file, one-liner to console).
   */
  static async json(label, obj, type = 'debug') {
    const level = LOG_LEVELS[type] ?? LOG_LEVELS.debug;
    if (level < MIN_LEVEL) return;

    const timestamp = new Date().toISOString();
    const oneLiner  = JSON.stringify(obj);
    const tag       = type.toUpperCase().padEnd(5);
    const colour    = COLOURS[type] ?? COLOURS.info;

    console.log(`${colour}[${tag}]${COLOURS.reset} ${label}: ${oneLiner}`);

    try {
      const logDir = path.join(process.cwd(), 'logs');
      await fs.mkdir(logDir, { recursive: true });
      const pretty = JSON.stringify(obj, null, 2);
      await fs.appendFile(
        path.join(logDir, 'trading.log'),
        `[${timestamp}] [${tag}] ${label}:\n${pretty}\n`
      );
    } catch { /* ignore */ }
  }
}
