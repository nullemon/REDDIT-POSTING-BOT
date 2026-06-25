// Structured console logging. Everything is visible via `wrangler tail`.
// Keep messages single-line JSON-ish so they're easy to grep in the tail stream.

type Fields = Record<string, unknown>;

function emit(level: string, msg: string, fields?: Fields) {
  const base: Fields = { level, msg };
  if (fields) Object.assign(base, fields);
  // console.log/warn/error are all surfaced by wrangler tail.
  const line = safeStringify(base);
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

function safeStringify(obj: Fields): string {
  try {
    return JSON.stringify(obj);
  } catch {
    return `{"level":"error","msg":"log serialization failed"}`;
  }
}

export const log = {
  info: (msg: string, fields?: Fields) => emit('info', msg, fields),
  warn: (msg: string, fields?: Fields) => emit('warn', msg, fields),
  error: (msg: string, fields?: Fields) => emit('error', msg, fields),
  debug: (msg: string, fields?: Fields) => emit('debug', msg, fields),
};
