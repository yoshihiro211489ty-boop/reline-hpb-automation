import pino from 'pino';
import path from 'path';
import fs from 'fs';
import { format } from 'date-fns';
import { toZonedTime } from 'date-fns-tz';

const TZ = 'Asia/Tokyo';

function getTodayLogDir(): string {
  const now = toZonedTime(new Date(), TZ);
  const dateStr = format(now, 'yyyy-MM-dd');
  const logDir = path.join(process.cwd(), 'logs', dateStr);
  if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir, { recursive: true });
    fs.mkdirSync(path.join(logDir, 'replies'), { recursive: true });
    fs.mkdirSync(path.join(logDir, 'blogs'), { recursive: true });
  }
  return logDir;
}

const logDir = getTodayLogDir();
const logFile = path.join(logDir, 'orchestrator.jsonl');

export const logger = pino(
  { level: 'info', timestamp: pino.stdTimeFunctions.isoTime },
  pino.destination({ dest: logFile, sync: false })
);

export const consoleLogger = pino({
  level: 'info',
  transport: { target: 'pino-pretty', options: { colorize: true } },
});

export function getLogDir(): string {
  return logDir;
}

export function getRepliesDir(): string {
  return path.join(logDir, 'replies');
}

export function getBlogsDir(): string {
  return path.join(logDir, 'blogs');
}
