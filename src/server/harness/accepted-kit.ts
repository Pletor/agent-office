import { createHash } from 'node:crypto';
import type http from 'node:http';
import type { ExecutionController } from '../opora/execution-controller.js';
import { send } from '../http/util.js';
import { validateSelection } from './selection-validation.js';

const MAX_BYTES = 96 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9_.:@/+-]{0,199}(?![\s\S])/;
const SLOT = /^[A-Za-z][A-Za-z0-9_.-]{0,79}(?![\s\S])/;
const CATEGORIES = new Set(['instructions', 'skills', 'hooks', 'rules', 'commands', 'scripts', 'tools',
  'mcp', 'memory', 'plugins', 'permissions', 'testing', 'operations']);
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, names: string[]) => Object.keys(v).length === names.length && names.every(k => Object.hasOwn(v, k));
const identifiers = (v: unknown, min: number, max: number): v is string[] => Array.isArray(v)
  && v.length >= min && v.length <= max && v.every(s => typeof s === 'string' && ID.test(s)) && new Set(v).size === v.length;
const invalid = (): never => { throw new Error('Accepted Harness kit is invalid; prepare and accept a corrected specification.'); };

/** Same bounded v1/v2 wire contracts as Canvas; no catalog lookup or permission grant. */
export function validateAcceptedKit(value: unknown) {
  const v2 = object(value) && value.schema === 'harness.kit/2';
  if (!object(value) || !keys(value, v2 ? ['schema', 'problems', 'resources', 'selection'] : ['schema', 'problems', 'resources'])
    || !['harness.kit/1', 'harness.kit/2'].includes(value.schema as string)
    || !identifiers(value.problems, 1, 8) || !Array.isArray(value.resources) || value.resources.length > 24) return invalid();
  const slots = new Set<string>(), resources = new Set<string>();
  for (const entry of value.resources) {
    if (!object(entry) || !keys(entry, ['slot', 'resource', 'category', 'digest', 'content', 'requires'])) return invalid();
    const { slot, resource, category, digest, content, requires } = entry;
    if (typeof slot !== 'string' || !SLOT.test(slot) || ['__proto__', 'prototype', 'constructor'].includes(slot)
      || typeof resource !== 'string' || !ID.test(resource) || slots.has(slot) || resources.has(resource)
      || typeof category !== 'string' || !CATEGORIES.has(category) || typeof content !== 'string'
      || content.length > MAX_BYTES || content.includes('\0') || !identifiers(requires, 0, 16)) return invalid();
    // JS replaces lone surrogates during UTF-8 encoding; Python rejects them. Reject before hashing.
    if ([...content].some(c => { const n = c.codePointAt(0)!; return n >= 0xd800 && n <= 0xdfff; })
      || digest !== createHash('sha256').update(content, 'utf8').digest('hex')) return invalid();
    slots.add(slot); resources.add(resource);
  }
  if (v2) validateSelection(value);
  const encoded = JSON.stringify(value).replace(/[\u007f-\uffff]/g, c => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
  if (Buffer.byteLength(encoded) > MAX_BYTES) return invalid();
  return value;
}

/** Only the target document contributes. A neighbor's kit must never become a fallback. */
export function acceptedKit(assignment: Record<string, unknown>, nodeId: string) {
  const documents = Object.hasOwn(assignment, 'documents') ? assignment.documents : [];
  if (!Array.isArray(documents)) return invalid();
  const targets = documents.filter(doc => object(doc) && doc.nodeId === nodeId);
  if (targets.length > 1) return invalid();
  if (!targets.length) return null;
  const fields = Object.hasOwn(targets[0], 'fields') ? targets[0].fields : {};
  if (!object(fields)) return invalid();
  return Object.hasOwn(fields, 'harness') ? validateAcceptedKit(fields.harness) : null;
}

/** Called only after the hook router authenticates the requesting worker. */
export function acceptedKitRequest(controller: ExecutionController, workerId: string, req: http.IncomingMessage,
  res: http.ServerResponse, url: URL) {
  const headers = { 'cache-control': 'no-store' };
  if (req.method !== 'GET') return send(res, 405, { error: 'Use GET' }, headers);
  if (url.searchParams.has('task')) return send(res, 400, { error: 'Accepted kit belongs to your current execution; omit task.' }, headers);
  const current = controller.assignmentFor(workerId);
  if (!current) return send(res, 409, { error: 'No valid Canvas execution for this worker.' }, headers);
  if (current.contextProtocolVersion !== 2) return send(res, 409, { error: 'Accepted kits require context protocol 2.' }, headers);
  try {
    const kit = acceptedKit(current.assignment, current.nodeId);
    const { assignment: _assignment, ...execution } = current;
    return send(res, 200, { execution, kit, evidence: 'accepted-selection-only', invocationObserved: false,
      capabilitiesVerified: false, promotionAllowed: false }, headers);
  } catch {
    return send(res, 409, { error: 'Accepted Harness kit is invalid; prepare and accept a corrected specification.' }, headers);
  }
}
