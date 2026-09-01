import util from 'node:util';

const MAX_LINES = 200;
const buffer: string[] = [];

function record(formatted: string): void {
  for (const line of formatted.split('\n')) {
    buffer.push(line);
    if (buffer.length > MAX_LINES) {
      buffer.shift();
    }
  }
}

function wrap(original: (...args: any[]) => void): (...args: any[]) => void {
  return (...args: any[]) => {
    record(util.format(...args));
    original(...args);
  };
}

// 攔截輸出，讓 /log 指令能讀到，同時原樣繼續印到 stdout/stderr（kubectl logs 不受影響）。
console.log = wrap(console.log.bind(console));
console.warn = wrap(console.warn.bind(console));
console.error = wrap(console.error.bind(console));

/** 取得最近 count 行 log（依實際輸出行數計算，一行多行的訊息如 stack trace 會被拆開計）。 */
export function getRecentLines(count: number): string[] {
  return buffer.slice(-count);
}
