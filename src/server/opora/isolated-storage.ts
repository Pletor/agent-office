import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeSync } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonical, digest, hash, object } from './executors/validation.js';
import type { ExecutionClaim, ExecutionLease } from './execution-client.js';
import { validateExecution } from './execution-client.js';
import type { ExecutionIntent } from './executors/types.js';
import { validateIntent } from './executors/validation.js';
import type { RemoteReportedResult } from './isolated-reports.js';

export interface IsolatedRequest { executorId: 'anthropic-managed-agents'; cardId: string; requestId: string }
export interface IsolatedRun {
  key: string; input: IsolatedRequest; project: string; workspace: string; base: string;
  stage: 'prepared' | 'claiming' | 'claimed' | 'bound' | 'running' | 'unknown' | 'termination_pending' | 'terminated' | 'failed';
  claim: ExecutionClaim | null; lease: ExecutionLease | null; intent: ExecutionIntent | null;
  observationHead: string | null; observationSequence: number; pendingObservation: Record<string, unknown> | null;
  lastObservationSemantic: string | null; terminalPolls: number; nextPollAt: number;
  pendingResult: { report: RemoteReportedResult; payload: Record<string, unknown>; attempted: boolean } | null;
  resultReceipt: Record<string, unknown> | null;
}
/** Broker-private atomic checkpoints. An uncertain write poisons further execution. */
export class IsolatedStore {
  private poisoned = false;
  /** A run moved to another stage (for the floor's process journal). */
  onStage?: (run: IsolatedRun, previous?: string) => void;
  constructor(private directory: string) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    if (lstatSync(directory).isSymbolicLink()) throw new Error('Private isolated state unavailable');
  }
  private file(key: string) { if (!hash(key)) throw new Error('Invalid isolated state'); return path.join(this.directory, key + '.json'); }
  private validate(value: unknown): IsolatedRun {
    if (!object(value) || !hash(value.key) || !object(value.input) || value.input.executorId !== 'anthropic-managed-agents'
      || typeof value.input.cardId !== 'string' || typeof value.input.requestId !== 'string'
      || !['prepared', 'claiming', 'claimed', 'bound', 'running', 'unknown', 'termination_pending', 'terminated', 'failed'].includes(value.stage)
      || typeof value.project !== 'string' || typeof value.workspace !== 'string' || typeof value.base !== 'string'
      || !(value.observationHead === null || hash(value.observationHead, 40)) || !Number.isSafeInteger(value.observationSequence) || value.observationSequence < 0
      || !(value.pendingObservation === null || object(value.pendingObservation))
      || !(value.lastObservationSemantic === null || hash(value.lastObservationSemantic))
      || !Number.isSafeInteger(value.terminalPolls) || value.terminalPolls < 0 || value.terminalPolls > 3
      || !Number.isFinite(value.nextPollAt) || value.nextPollAt < 0
      || !(value.pendingResult === null || (object(value.pendingResult) && object(value.pendingResult.report) && object(value.pendingResult.payload)
        && typeof value.pendingResult.attempted === 'boolean'))
      || !(value.resultReceipt === null || object(value.resultReceipt))) throw new Error('Invalid isolated state');
    if (value.lease !== null) validateExecution(value.lease, { project: value.project, workspace: value.workspace, nodeId: value.input.cardId });
    if (value.intent !== null) validateIntent(value.intent);
    if (value.claim !== null && (!object(value.claim) || value.claim.project !== value.project || value.claim.workspace !== value.workspace
      || value.claim.nodeId !== value.input.cardId || typeof value.claim.requestId !== 'string')) throw new Error('Invalid isolated claim');
    return structuredClone(value) as IsolatedRun;
  }
  read(key: string): IsolatedRun | null {
    if (this.poisoned) throw new Error('Private isolated state unavailable');
    const file = this.file(key); if (!existsSync(file)) return null;
    try {
      if (lstatSync(file).isSymbolicLink() || statSync(file).size > 8 * 1024 * 1024) throw new Error();
      const envelope = JSON.parse(readFileSync(file, 'utf8'));
      if (!object(envelope) || Object.keys(envelope).length !== 2 || digest(envelope.record) !== envelope.digest || envelope.record.key !== key) throw new Error();
      return this.validate(envelope.record);
    } catch { this.poisoned = true; throw new Error('Private isolated state unavailable'); }
  }
  list() {
    const files = readdirSync(this.directory); if (files.length > 128) throw new Error('Private isolated state unavailable');
    return files.map(file => {
      if (!/^[a-f0-9]{64}\.json$/.test(file)) throw new Error('Uncertain isolated checkpoint');
      return this.read(file.slice(0, 64))!;
    });
  }
  save(run: IsolatedRun) {
    if (this.poisoned) throw new Error('Private isolated state unavailable');
    const checked = this.validate(run), file = this.file(run.key);
    const previous = this.read(run.key);
    if (previous && (canonical(previous.input) !== canonical(run.input) || previous.project !== run.project || previous.workspace !== run.workspace
      || previous.base !== run.base || (previous.claim && canonical(previous.claim) !== canonical(run.claim))
      || (previous.intent && canonical(previous.intent) !== canonical(run.intent))
      || (previous.pendingResult && (!run.pendingResult || canonical(previous.pendingResult.report) !== canonical(run.pendingResult.report)
        || canonical(previous.pendingResult.payload) !== canonical(run.pendingResult.payload) || (previous.pendingResult.attempted && !run.pendingResult.attempted)))
      || (previous.resultReceipt && canonical(previous.resultReceipt) !== canonical(run.resultReceipt)))) throw new Error('Isolated immutable binding changed');
    const bytes = Buffer.from(canonical({ record: checked, digest: digest(checked) }));
    if (bytes.length > 8 * 1024 * 1024) throw new Error('Private isolated state too large');
    const temporary = file + '.' + randomUUID() + '.pending';
    try {
      const files = readdirSync(this.directory);
      if (files.length > 128 || files.reduce((sum, name) => sum + statSync(path.join(this.directory, name)).size, bytes.length) > 64 * 1024 * 1024) throw new Error();
      const fd = openSync(temporary, 'wx', 0o600);
      try { let offset = 0; while (offset < bytes.length) { const n = writeSync(fd, bytes, offset); if (!n) throw new Error(); offset += n; } fsyncSync(fd); }
      finally { closeSync(fd); }
      renameSync(temporary, file);
    } catch { this.poisoned = true; if (existsSync(temporary)) unlinkSync(temporary); throw new Error('Private isolated checkpoint failed'); }
    if (previous?.stage !== run.stage) try { this.onStage?.(checked, previous?.stage); } catch { /* never fails a checkpoint */ }
  }
}
