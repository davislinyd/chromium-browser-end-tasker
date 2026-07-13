/**
 * In-memory ring buffer for popup debugging.
 * Copy via DebugLog.copy(); live UI via DebugLog.subscribe().
 */
(function () {
  const MAX_LINES = 400;
  /** @type {string[]} */
  const lines = [];
  /** @type {Set<(lines: string[]) => void>} */
  const listeners = new Set();

  function timestamp() {
    try {
      return new Date().toISOString();
    } catch {
      return String(Date.now());
    }
  }

  function formatData(data) {
    if (data === undefined) return '';
    try {
      return ' ' + JSON.stringify(data);
    } catch {
      try {
        return ' ' + String(data);
      } catch {
        return ' [unserializable]';
      }
    }
  }

  function notify() {
    const snapshot = lines.slice();
    for (const listener of listeners) {
      try {
        listener(snapshot);
      } catch {
        // ignore subscriber errors
      }
    }
  }

  function push(level, message, data) {
    const line = `[${timestamp()}] ${level}: ${message}${formatData(data)}`;
    lines.push(line);
    if (lines.length > MAX_LINES) {
      lines.splice(0, lines.length - MAX_LINES);
    }
    try {
      if (level === 'ERROR') console.error(line);
      else if (level === 'WARN') console.warn(line);
      else console.log(line);
    } catch {
      // ignore console failures
    }
    notify();
    return line;
  }

  async function copyToClipboard() {
    const text =
      lines.length > 0
        ? lines.join('\n')
        : `(empty log) ${timestamp()}`;
    if (navigator?.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return { ok: true, chars: text.length, lines: lines.length };
    }
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (!ok) throw new Error('clipboard write failed');
    return { ok: true, chars: text.length, lines: lines.length };
  }

  globalThis.DebugLog = {
    info(message, data) {
      return push('INFO', message, data);
    },
    warn(message, data) {
      return push('WARN', message, data);
    },
    error(message, data) {
      return push('ERROR', message, data);
    },
    getText() {
      return lines.join('\n');
    },
    getLines() {
      return lines.slice();
    },
    getLineCount() {
      return lines.length;
    },
    clear() {
      lines.length = 0;
      notify();
    },
    /**
     * @param {(lines: string[]) => void} listener
     * @returns {() => void} unsubscribe
     */
    subscribe(listener) {
      if (typeof listener !== 'function') return () => {};
      listeners.add(listener);
      try {
        listener(lines.slice());
      } catch {
        // ignore
      }
      return () => {
        listeners.delete(listener);
      };
    },
    copy: copyToClipboard,
  };
})();
