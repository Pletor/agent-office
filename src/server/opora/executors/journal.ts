import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { canonical, digest, hash, id, monotonic, validateIntent, validateObservation } from './validation.js';
import { ExecutorFailure, type ExecutionIntent, type ExecutionRecord, type ExecutorState, type ProviderObservation } from './types.js';

const STATES: Record<ExecutorState, ExecutorState[]> = {
  intent: ['creating'], creating: ['mapped', 'creation_unknown'], creation_unknown: [],
  mapped: ['mapped', 'starting', 'termination_pending', 'terminated'], starting: ['running', 'termination_pending', 'terminated'],
  running: ['running', 'termination_pending', 'terminated'], termination_pending: ['termination_pending', 'terminated'], terminated: ['terminated'],
};
interface Row extends ExecutionRecord { version: 1; sequence: number; previous: string | null; checksum: string }
/** Exclusive broker-owned journal. Torn writes/corruption poison it; no silent repair or relaunch. */
export class ExecutorJournal {
  private poisoned = false;
  private closed = false;
  private readonly lock: string;
  constructor(private readonly directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new ExecutorFailure();
    this.lock = path.join(directory, 'owner.lock');
    if (existsSync(this.lock)) {
      let owner: unknown;
      try { owner = JSON.parse(readFileSync(this.lock, 'utf8')); } catch { throw new ExecutorFailure(); }
      if (!Number.isSafeInteger(owner) || (owner as number) < 1) throw new ExecutorFailure();
      try { process.kill(owner as number, 0); throw new ExecutorFailure(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw new ExecutorFailure(); }
      unlinkSync(this.lock);
    }
    const fd = openSync(this.lock, 'wx', 0o600);
    try { writeSync(fd, JSON.stringify(process.pid)); fsyncSync(fd); } finally { closeSync(fd); }
  }
  private check() { if (this.poisoned || this.closed) throw new ExecutorFailure(); }
  private filename(identifier: string) {
    if (!hash(identifier, 40)) throw new ExecutorFailure();
    return path.join(this.directory, identifier + '.jsonl');
  }
  private rows(identifier: string): Row[] {
    this.check();
    const file = this.filename(identifier);
    if (!existsSync(file)) return [];
    try {
      if (lstatSync(file).isSymbolicLink() || statSync(file).size > 4 * 1024 * 1024) throw new ExecutorFailure();
      const text = readFileSync(file, 'utf8');
      if (!text.endsWith('\n')) throw new ExecutorFailure();
      const lines = text.slice(0, -1).split('\n');
      if (!lines.length || lines.length > 4096) throw new ExecutorFailure();
      const rows: Row[] = [];
      for (const line of lines) {
        const row = JSON.parse(line) as Row, { checksum, ...body } = row;
        const prior = rows.at(-1);
        validateIntent(row.intent);
        if (row.intent.intentId !== identifier || row.version !== 1 || row.sequence !== rows.length + 1
          || row.previous !== (prior?.checksum ?? null) || digest(body) !== checksum || Object.keys(row).length !== 8
          || !(row.state in STATES) || (row.sessionId !== null && !id(row.sessionId))) throw new ExecutorFailure();
        if (!prior) {
          if (row.state !== 'intent' || row.sessionId !== null || row.observation !== null) throw new ExecutorFailure();
        } else {
          if (canonical(prior.intent) !== canonical(row.intent) || !STATES[prior.state].includes(row.state)
            || (prior.sessionId !== null && row.sessionId !== prior.sessionId)
            || (row.sessionId === null && !['creating', 'creation_unknown'].includes(row.state))) throw new ExecutorFailure();
        }
        if (row.observation !== null) {
          if (!row.sessionId) throw new ExecutorFailure();
          validateObservation(row.observation, row.intent, row.sessionId);
          monotonic(prior?.observation ?? null, row.observation);
        } else if (prior?.observation) throw new ExecutorFailure();
        if (row.state === 'terminated' && row.observation?.status !== 'terminated') throw new ExecutorFailure();
        rows.push(row);
      }
      return rows;
    } catch { this.poisoned = true; throw new ExecutorFailure(); }
  }
  read(identifier: string): ExecutionRecord | null {
    const row = this.rows(identifier).at(-1);
    return row ? structuredClone({ intent: row.intent, state: row.state, sessionId: row.sessionId, observation: row.observation }) : null;
  }
  /** Private broker recovery only. Public routes must return executor.status(), never these intents. */
  list(): ExecutionRecord[] { this.check(); return this.entries(); }
  create(intent: ExecutionIntent): ExecutionRecord {
    this.check(); validateIntent(intent);
    if (readdirSync(this.directory).length > 1024 || this.read(intent.intentId)) throw new ExecutorFailure();
    for (const entry of this.entries()) {
      if (entry.intent.executionId === intent.executionId && entry.intent.epoch === intent.epoch) throw new ExecutorFailure();
    }
    return this.write({ intent, state: 'intent', sessionId: null, observation: null }, null);
  }
  private entries() {
    const records: ExecutionRecord[] = []; let bytes = 0;
    for (const file of readdirSync(this.directory)) {
      if (file === 'owner.lock') continue;
      if (!/^[a-f0-9]{40}\.jsonl$/.test(file)) throw new ExecutorFailure();
      bytes += statSync(path.join(this.directory, file)).size;
      if (bytes > 64 * 1024 * 1024) throw new ExecutorFailure();
      const record = this.read(file.slice(0, 40)); if (record) records.push(record);
    }
    return records;
  }
  advance(identifier: string, state: ExecutorState, sessionId?: string, observation?: ProviderObservation) {
    const prior = this.rows(identifier).at(-1);
    if (!prior || !STATES[prior.state].includes(state)) throw new ExecutorFailure();
    if (sessionId && this.entries().some(record => record.intent.intentId !== identifier && record.sessionId === sessionId)) throw new ExecutorFailure();
    return this.write({ intent: prior.intent, state, sessionId: sessionId ?? prior.sessionId, observation: observation ?? prior.observation }, prior);
  }
  private write(record: ExecutionRecord, prior: Row | null): ExecutionRecord {
    this.check();
    const body = { ...record, version: 1, sequence: (prior?.sequence ?? 0) + 1, previous: prior?.checksum ?? null };
    const row = { ...body, checksum: digest(body) };
    const text = canonical(row) + '\n';
    try {
      const files = readdirSync(this.directory);
      if (files.length > 1025) throw new ExecutorFailure();
      let total = Buffer.byteLength(text);
      for (const file of files) {
        if (file === 'owner.lock') continue;
        if (!/^[a-f0-9]{40}\.jsonl$/.test(file) || lstatSync(path.join(this.directory, file)).isSymbolicLink()) throw new ExecutorFailure();
        total += statSync(path.join(this.directory, file)).size;
        if (total > 64 * 1024 * 1024) throw new ExecutorFailure();
      }
      if (prior && (prior.sequence >= 4096 || statSync(this.filename(record.intent.intentId)).size + Buffer.byteLength(text) > 4 * 1024 * 1024)) throw new ExecutorFailure();
      const fd = openSync(this.filename(record.intent.intentId), prior ? 'a' : 'wx', 0o600);
      try {
        const bytes = Buffer.from(text); let offset = 0;
        while (offset < bytes.length) { const count = writeSync(fd, bytes, offset); if (!count) throw new ExecutorFailure(); offset += count; }
        fsyncSync(fd);
      } finally { closeSync(fd); }
      // Validate the persisted chain before permitting the next provider side effect.
      return this.read(record.intent.intentId)!;
    } catch { this.poisoned = true; throw new ExecutorFailure(); }
  }
  close() { if (!this.closed) { this.closed = true; unlinkSync(this.lock); } }
}
