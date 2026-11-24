'use strict';

/**
 * Durable, append-only NDJSON file store for the hash-chained audit log,
 * with size-based segment rotation.
 *
 * Entries are stored one JSON object per line (`\n`-terminated). Every append
 * is written and `fsync`ed before returning so entries survive an unclean
 * exit. When the active file exceeds `rotateBytes`, it is closed and renamed
 * to `<path>.<n>` (`n = 1, 2, ...`, monotonically increasing) and a fresh
 * `<path>` is started whose first entry links (`prevHash`) to the rotated
 * segment's last hash.
 *
 * On startup, existing segments (`<path>.1 .. <path>.N` followed by `<path>`)
 * are replayed in order and verified with `verifyChain`:
 * - By default (`onCorrupt: 'throw'`), any hash/sequence error or malformed /
 *   truncated line throws `AuditIntegrityError` so the process refuses to
 *   start against a tampered log.
 * - With `onCorrupt: 'flag'`, replay records the broken state (`corrupt()`,
 *   which `createAuditLog.verify()` surfaces) instead of throwing.
 *
 * In memory, at most the newest `maxEntries` entries are cached (deeply
 * frozen) for `entries()` / `query()`; even if all entries are evicted from
 * the in-memory window, the last entry (`seq` and `hash`) is retained so new
 * appends continue the chain seamlessly across restarts and rotations.
 */

const fs = require('fs');
const path = require('path');

class AuditIntegrityError extends Error {
  /**
   * @param {string} message human-readable description
   * @param {{ brokenAt: number, reason: string, file?: string }} details failure details
   */
  constructor(message, { brokenAt = 1, reason = 'corrupt_chain', file } = {}) {
    super(message);
    this.name = 'AuditIntegrityError';
    this.brokenAt = brokenAt;
    this.reason = reason;
    if (file !== undefined) {
      this.file = file;
    }
  }
}

/**
 * @param {*} value entry or nested value
 * @returns {*} the same value, deeply frozen
 */
function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    Object.values(value).forEach(deepFreeze);
  }
  return value;
}

/**
 * Lists rotated segment files (`<base>.1`, `<base>.2`, ...) in ascending numeric order.
 *
 * @param {string} filePath active audit log file path
 * @returns {{ index: number, filePath: string }[]} ordered rotated segments
 */
function listRotatedSegments(filePath) {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  if (!fs.existsSync(dir)) {
    return [];
  }
  const prefix = `${base}.`;
  const segments = [];
  for (const name of fs.readdirSync(dir)) {
    if (name.startsWith(prefix)) {
      const suffix = name.slice(prefix.length);
      if (/^[1-9]\d*$/.test(suffix)) {
        segments.push({ index: Number(suffix), filePath: path.join(dir, name) });
      }
    }
  }
  segments.sort((a, b) => a.index - b.index);
  return segments;
}

/**
 * Creates a file-backed audit store.
 *
 * @param {object} options store options
 * @param {string} options.path path to the active NDJSON audit log file (or `filePath`)
 * @param {string} [options.filePath] alias for `path`
 * @param {number} [options.maxEntries=10000] maximum entries kept in memory
 * @param {number} [options.rotateBytes=0] rotate active file when its size exceeds this (>0 enables rotation)
 * @param {'throw'|'flag'} [options.onCorrupt='throw'] whether to throw on boot corruption or flag verify as broken
 * @param {Function} [options.verifyChain] chain verifier (injected by audit-log to avoid circular dependency)
 * @returns {object} store implementing last(), append(entry), entries(), size(), segments(), corrupt(), resetForTests()
 */
function createFileStore(options = {}) {
  const targetPath = options.path || options.filePath;
  if (typeof targetPath !== 'string' || !targetPath.trim()) {
    throw new TypeError('createFileStore requires a non-empty file path');
  }
  const resolvedPath = path.resolve(targetPath.trim());
  const limit = Number.isInteger(options.maxEntries) && options.maxEntries > 0 ? options.maxEntries : 10000;
  const rotateBytes =
    Number.isInteger(options.rotateBytes) && options.rotateBytes > 0 ? options.rotateBytes : 0;
  const onCorrupt = options.onCorrupt === 'flag' ? 'flag' : 'throw';
  const verifyChainFn =
    typeof options.verifyChain === 'function'
      ? options.verifyChain
      : require('./audit-log').verifyChain;

  fs.mkdirSync(path.dirname(resolvedPath), { recursive: true });

  let items = [];
  let lastEntry = null;
  let corruption = null;
  let nextSegmentIndex = 1;

  function failOrFlag(message, details) {
    const err = new AuditIntegrityError(message, details);
    if (onCorrupt === 'flag') {
      if (!corruption) {
        corruption = {
          valid: false,
          brokenAt: err.brokenAt,
          reason: err.reason,
        };
      }
      return;
    }
    throw err;
  }

  /**
   * Replays all existing segments and the active file in order, validating the
   * NDJSON framing (including trailing newline to detect truncated final lines)
   * and the full hash chain across segment boundaries.
   */
  function replay() {
    const rotated = listRotatedSegments(resolvedPath);
    if (rotated.length > 0) {
      nextSegmentIndex = rotated[rotated.length - 1].index + 1;
    } else {
      nextSegmentIndex = 1;
    }

    const filesToRead = rotated.map((s) => s.filePath);
    if (fs.existsSync(resolvedPath)) {
      filesToRead.push(resolvedPath);
    }

    const allEntries = [];
    for (const file of filesToRead) {
      const raw = fs.readFileSync(file, 'utf8');
      if (raw.length === 0) {
        continue;
      }
      if (!raw.endsWith('\n')) {
        const linesSoFar = raw.split('\n').filter((l) => l.trim().length > 0);
        let brokenSeq = allEntries.length + linesSoFar.length;
        if (brokenSeq < 1) {
          brokenSeq = 1;
        }
        // Try to see if earlier lines in this file were valid entries to pinpoint the truncated last line
        const lastKnownSeq = allEntries.length ? allEntries[allEntries.length - 1].seq : 0;
        brokenSeq = lastKnownSeq + linesSoFar.length;
        failOrFlag(`Audit log file "${file}" has a truncated final line (missing trailing newline)`, {
          brokenAt: brokenSeq || 1,
          reason: 'truncated_line',
          file,
        });
        if (corruption) {
          // Parse any complete lines before the truncated final line
          const parts = raw.split('\n');
          const truncatedLine = parts.pop();
          for (const line of parts) {
            if (!line.trim()) {
              continue;
            }
            try {
              allEntries.push(deepFreeze(JSON.parse(line)));
            } catch {
              // already flagged
            }
          }
          if (truncatedLine && truncatedLine.trim()) {
            try {
              allEntries.push(deepFreeze(JSON.parse(truncatedLine)));
            } catch {
              // ignore unparseable truncated tail after flagging
            }
          }
          continue;
        }
      }

      const lines = raw.split('\n');
      // Last element after split('\n') on a '\n'-ended string is ''
      if (lines[lines.length - 1] === '') {
        lines.pop();
      }

      for (let i = 0; i < lines.length; i += 1) {
        const line = lines[i];
        const expectedSeq = (allEntries.length ? allEntries[allEntries.length - 1].seq : 0) + 1;
        if (!line.trim()) {
          failOrFlag(`Audit log file "${file}" contains an empty line at line ${i + 1}`, {
            brokenAt: expectedSeq,
            reason: 'malformed_json',
            file,
          });
          continue;
        }
        let parsed;
        try {
          parsed = JSON.parse(line);
        } catch (parseErr) {
          failOrFlag(`Audit log file "${file}" contains malformed JSON at line ${i + 1}: ${parseErr.message}`, {
            brokenAt: expectedSeq,
            reason: 'malformed_json',
            file,
          });
          continue;
        }
        allEntries.push(deepFreeze(parsed));
      }
    }

    if (allEntries.length > 0) {
      // First entry across all segments must anchor to GENESIS_HASH at seq 1 unless earlier segments were externally archived
      const verification = verifyChainFn(allEntries);
      if (!verification.valid) {
        failOrFlag(`Audit log hash chain is corrupt at seq ${verification.brokenAt}`, {
          brokenAt: verification.brokenAt,
          reason: 'hash_mismatch',
        });
      }
      lastEntry = allEntries[allEntries.length - 1];
      items = allEntries.length > limit ? allEntries.slice(allEntries.length - limit) : allEntries;
    }
  }

  replay();

  /**
   * Rotates the active log file to `<path>.<nextSegmentIndex>` if adding
   * `incomingBytes` (or the current size itself) exceeds `rotateBytes` and the
   * active file already has at least one entry.
   *
   * @param {number} incomingBytes byte length of the line about to be written
   */
  function maybeRotate(incomingBytes) {
    if (rotateBytes <= 0 || !fs.existsSync(resolvedPath)) {
      return;
    }
    const stat = fs.statSync(resolvedPath);
    if (stat.size === 0) {
      return;
    }
    if (stat.size >= rotateBytes || stat.size + incomingBytes > rotateBytes) {
      const rotatedPath = `${resolvedPath}.${nextSegmentIndex}`;
      nextSegmentIndex += 1;
      fs.renameSync(resolvedPath, rotatedPath);
    }
  }

  /**
   * Appends a single line to the active file and flushes it to disk with `fsyncSync`.
   *
   * @param {string} line NDJSON line ending with `\n`
   */
  function writeLineSync(line) {
    const buf = Buffer.from(line, 'utf8');
    maybeRotate(buf.length);
    const fd = fs.openSync(resolvedPath, 'a', 0o600);
    try {
      fs.writeSync(fd, buf, 0, buf.length);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  return {
    path: resolvedPath,

    last: () => lastEntry,

    append(entry) {
      if (corruption) {
        throw new AuditIntegrityError(
          `Cannot append to corrupt audit log (broken at seq ${corruption.brokenAt})`,
          corruption,
        );
      }
      const frozen = deepFreeze(entry);
      const line = `${JSON.stringify(frozen)}\n`;
      writeLineSync(line);
      lastEntry = frozen;
      items.push(frozen);
      if (items.length > limit) {
        items = items.slice(items.length - limit);
      }
    },

    /**
     * Reads retained entries (deeply frozen) from disk or memory.
     * Re-reading and freezing from disk ensures direct file edits after boot
     * are caught by `verify()`, while respecting `maxEntries`.
     *
     * @returns {object[]} deeply frozen entries, oldest first
     */
    entries() {
      const rotated = listRotatedSegments(resolvedPath).map((s) => s.filePath);
      const files = fs.existsSync(resolvedPath) ? [...rotated, resolvedPath] : rotated;
      if (files.length === 0) {
        return items.slice();
      }
      const loaded = [];
      for (const file of files) {
        const raw = fs.readFileSync(file, 'utf8');
        if (!raw) {
          continue;
        }
        if (!raw.endsWith('\n')) {
          const lines = raw.split('\n');
          for (let i = 0; i < lines.length; i += 1) {
            const line = lines[i];
            if (!line.trim()) {
              continue;
            }
            try {
              loaded.push(deepFreeze(JSON.parse(line)));
            } catch {
              const brokenSeq = (loaded.length ? loaded[loaded.length - 1].seq : 0) + 1;
              loaded.push(deepFreeze({ seq: brokenSeq, hash: null }));
            }
          }
          // If the truncated line happened to parse as valid JSON, still mark it invalid because it lacked trailing newline
          const lastTail = lines[lines.length - 1];
          if (lastTail && lastTail.trim() && loaded.length > 0 && loaded[loaded.length - 1].hash !== null) {
            const tailEntry = loaded[loaded.length - 1];
            loaded[loaded.length - 1] = deepFreeze({ ...tailEntry, hash: 'truncated' });
          }
          continue;
        }
        const lines = raw.split('\n');
        if (lines[lines.length - 1] === '') {
          lines.pop();
        }
        for (const line of lines) {
          if (!line.trim()) {
            const brokenSeq = (loaded.length ? loaded[loaded.length - 1].seq : 0) + 1;
            loaded.push(deepFreeze({ seq: brokenSeq, hash: null }));
            continue;
          }
          try {
            loaded.push(deepFreeze(JSON.parse(line)));
          } catch {
            const brokenSeq = (loaded.length ? loaded[loaded.length - 1].seq : 0) + 1;
            loaded.push(deepFreeze({ seq: brokenSeq, hash: null }));
          }
        }
      }
      return loaded.length > limit ? loaded.slice(loaded.length - limit) : loaded;
    },

    size: () => items.length,

    /**
     * @returns {string[]} ordered list of segment paths on disk (rotated first, then active if present)
     */
    segments() {
      const rotated = listRotatedSegments(resolvedPath).map((s) => s.filePath);
      return fs.existsSync(resolvedPath) ? [...rotated, resolvedPath] : rotated;
    },

    /**
     * @returns {{ valid: false, brokenAt: number, reason: string } | null} boot-time corruption state if `onCorrupt: 'flag'` was used
     */
    corrupt: () => corruption,

    /** Empties the store and removes its segment files. Tests only. */
    resetForTests() {
      for (const seg of listRotatedSegments(resolvedPath)) {
        fs.rmSync(seg.filePath, { force: true });
      }
      fs.rmSync(resolvedPath, { force: true });
      items = [];
      lastEntry = null;
      corruption = null;
      nextSegmentIndex = 1;
    },
  };
}

module.exports = {
  createFileStore,
  AuditIntegrityError,
  deepFreeze,
};
