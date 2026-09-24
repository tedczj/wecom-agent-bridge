import { randomUUID } from 'node:crypto';
import type { Store } from '../store.ts';
import { invariant } from '../errors.ts';
import { sha256 } from './requests.ts';
import { reached80 } from '../controllers/rotation.ts';
import type { ContextUsageSnapshot, ControllerRef } from '../controllers/runtime.ts';

export type ControllerState = 'creating' | 'ready' | 'running' | 'rotate_pending' | 'retired' | 'usage_unknown' | 'failed';
export type RotationReason = 'usage_80' | 'config_changed' | 'runtime_recovery';
export interface ControllerSession {
  controller_id: string; logical_key: string; conversation_scope: string; role: 'bridge' | 'route';
  directory_identity: string | null; generation: number; is_current: number; state: ControllerState;
  native_ref_json: string | null; model_profile_digest: string; usage_json: string | null;
}
export interface ControllerAuditEvent {
  at: number; role: 'bridge' | 'route';
  event: 'controller.created' | 'controller.resumed' | 'controller.usage_observed' | 'controller.usage_unknown' | 'controller.rotate_requested' | 'controller.rotated';
  controllerId: string; generation: number; threadId?: string; turnId?: string; usedTokens?: number; contextWindowTokens?: number;
  basis?: 'last-completed-request-total'; reason?: RotationReason; bindingDigest?: string;
}
export type ControllerAudit = (event: ControllerAuditEvent) => void;
export const logController: ControllerAudit = event => { process.stderr.write(JSON.stringify(event) + '\n'); };

/** Short SQL transactions fence native callbacks; parent waits never hold a transaction. */
export class ControllerRegistry {
  constructor(private store: Store, private audit: ControllerAudit = logController) {}
  current(logicalKey: string): ControllerSession | undefined {
    return this.store.db.prepare('SELECT * FROM controller_sessions WHERE logical_key=? AND is_current=1').get(logicalKey) as ControllerSession | undefined;
  }
  get(id: string): ControllerSession {
    const row = this.store.db.prepare('SELECT * FROM controller_sessions WHERE controller_id=?').get(id) as ControllerSession | undefined;
    invariant(row, 'CONTROLLER_NOT_FOUND'); return row;
  }
  prepare(scope: string, role: 'bridge' | 'route', directoryIdentity: string | null, digest: string, policyDigest?: string): ControllerSession {
    invariant(role === 'bridge' ? directoryIdentity === null : !!directoryIdentity, 'CONTROLLER_DIRECTORY');
    return this.store.atomic(() => {
      const key = sha256(JSON.stringify([scope, role, directoryIdentity]));
      invariant(!this.store.db.prepare("SELECT 1 FROM controller_sessions WHERE logical_key=? AND state='creating'").get(key), 'CONTROLLER_CREATION_BUSY');
      const old = this.current(key);
      if (old) invariant(old.state !== 'running', 'CONTROLLER_BUSY');
      const latest = this.store.db.prepare('SELECT MAX(generation) generation FROM controller_sessions WHERE logical_key=?').get(key) as { generation: number | null };
      const id = randomUUID(), generation = (latest.generation ?? -1) + 1, now = Date.now();
      this.store.db.prepare(`INSERT INTO controller_sessions(controller_id,logical_key,conversation_scope,role,directory_identity,generation,
        is_current,state,runtime_kind,model_profile_digest,created_at,updated_at) VALUES (?,?,?,?,?,?,0,'creating','codex-app-server',?,?,?)`)
        .run(id, key, scope, role, directoryIdentity, generation, digest, now, now);
      if (policyDigest) this.store.put('controller:policy:' + id, policyDigest);
      return this.get(id);
    });
  }
  registerNative(id: string, ref: ControllerRef, backendHomeKey: string): void {
    this.store.atomic(() => {
      const row = this.get(id);
      invariant(row.state === 'creating' && ref.generation === row.generation && !row.native_ref_json, 'CONTROLLER_GENERATION_CONFLICT');
      this.store.db.prepare('UPDATE controller_sessions SET native_ref_json=?,updated_at=? WHERE controller_id=?')
        .run(JSON.stringify(ref), Date.now(), id);
      this.store.db.prepare(`INSERT INTO native_session_catalog(native_ref_key,backend_home_key,backend,native_id,directory_identity,native_ref_json,
        role,verification_state,observed_at) VALUES (?,?,'codex',?,?,?,?,'metadata-only',?)`).run(sha256(JSON.stringify([backendHomeKey, ref.threadId])),
        backendHomeKey, ref.threadId, row.directory_identity, JSON.stringify(ref), row.role, Date.now());
    });
    const row = this.get(id);
    this.audit({ event: 'controller.created', at: Date.now(), role: row.role, controllerId: id, generation: row.generation, threadId: ref.threadId });
  }
  private bindingDigest(scope: string): string {
    const bindings = this.store.db.prepare('SELECT directory_identity,backend_home_key,profile_digest,session_key,version FROM business_bindings WHERE conversation_scope=? ORDER BY directory_identity,backend_home_key,profile_digest').all(scope);
    return sha256(JSON.stringify(bindings));
  }
  initialized(id: string, turnId: string, usage: ContextUsageSnapshot): void {
    this.store.atomic(() => {
      const row = this.get(id), ref = row.native_ref_json ? JSON.parse(row.native_ref_json) as ControllerRef : undefined;
      invariant(row.state === 'creating' && ref && usage.threadId === ref.threadId && usage.turnId === turnId &&
        usage.validForGeneration === row.generation && usage.origin === 'runtime' && usage.basis === 'last-completed-request-total' &&
        Number.isSafeInteger(usage.usedTokens) && Number.isSafeInteger(usage.contextWindowTokens), 'USAGE_IDENTITY_MISMATCH');
      invariant(!reached80(BigInt(usage.usedTokens), BigInt(usage.contextWindowTokens)), 'HANDOFF_OVERSIZED');
      this.store.db.prepare('UPDATE controller_sessions SET usage_json=?,updated_at=? WHERE controller_id=?').run(JSON.stringify(usage), Date.now(), id);
      this.store.put('controller:last-completed:' + id, turnId);
    });
  }
  resumed(id: string): void {
    const row = this.get(id), ref = JSON.parse(row.native_ref_json!) as ControllerRef;
    this.audit({ event: 'controller.resumed', at: Date.now(), role: row.role, controllerId: id, generation: row.generation, threadId: ref.threadId });
  }
  activate(id: string, expectedOldId: string | null, reason?: RotationReason): void {
    const row = this.store.atomic(() => {
      const next = this.get(id), old = this.current(next.logical_key);
      invariant(next.state === 'creating' && next.native_ref_json && (old?.controller_id ?? null) === expectedOldId, 'CONTROLLER_GENERATION_CONFLICT');
      if (old) {
        const nextPolicy = this.store.value<string>('controller:policy:' + id), oldPolicy = this.store.value<string>('controller:policy:' + old.controller_id);
        invariant(old.state !== 'running' && reason && (reason === 'config_changed' ? old.model_profile_digest !== next.model_profile_digest ||
          typeof nextPolicy === 'string' && nextPolicy !== oldPolicy :
          reason === 'runtime_recovery' ? old.state === 'failed' : old.state === 'rotate_pending'), 'CONTROLLER_ROTATION_NOT_READY');
        this.store.db.prepare("UPDATE controller_sessions SET state='retired',is_current=0,updated_at=? WHERE controller_id=?").run(Date.now(), old.controller_id);
      }
      this.store.db.prepare("UPDATE controller_sessions SET state='ready',is_current=1,updated_at=? WHERE controller_id=?").run(Date.now(), id);
      return next;
    });
    if (expectedOldId) this.audit({ event: 'controller.rotated', at: Date.now(), role: row.role, controllerId: id, generation: row.generation, reason,
      bindingDigest: this.bindingDigest(row.conversation_scope) });
  }
  beginTurn(id: string): ControllerRef {
    return this.store.atomic(() => {
      const row = this.get(id);
      invariant(row.is_current === 1 && row.state === 'ready' && row.native_ref_json, 'CONTROLLER_NOT_READY');
      this.store.db.prepare("UPDATE controller_sessions SET state='running',updated_at=? WHERE controller_id=?").run(Date.now(), id);
      return JSON.parse(row.native_ref_json) as ControllerRef;
    });
  }
  fence(id: string, generation: number): ControllerSession {
    const row = this.get(id);
    invariant(row.is_current === 1 && row.generation === generation && row.state === 'running', 'CONTROLLER_STALE_CALLBACK'); return row;
  }
  completeTurn(id: string, turnId: string, usage?: ContextUsageSnapshot): void {
    const row = this.store.atomic(() => {
      const row = this.get(id), ref = row.native_ref_json ? JSON.parse(row.native_ref_json) as ControllerRef : undefined;
      this.fence(id, row.generation);
      if (usage) invariant(ref && usage.threadId === ref.threadId && usage.turnId === turnId && usage.validForGeneration === row.generation &&
        usage.origin === 'runtime' && usage.basis === 'last-completed-request-total' && Number.isSafeInteger(usage.usedTokens) &&
        Number.isSafeInteger(usage.contextWindowTokens), 'USAGE_IDENTITY_MISMATCH');
      const rotate = usage && reached80(BigInt(usage.usedTokens), BigInt(usage.contextWindowTokens));
      this.store.db.prepare('UPDATE controller_sessions SET state=?,usage_json=?,updated_at=? WHERE controller_id=?')
        .run(!usage ? 'usage_unknown' : rotate ? 'rotate_pending' : 'ready', usage ? JSON.stringify(usage) : null, Date.now(), id);
      this.store.put('controller:last-completed:' + id, turnId);
      return this.get(id);
    });
    this.audit({ event: usage ? 'controller.usage_observed' : 'controller.usage_unknown', at: Date.now(), role: row.role, controllerId: id, generation: row.generation,
      turnId, threadId: usage?.threadId, usedTokens: usage?.usedTokens, contextWindowTokens: usage?.contextWindowTokens, basis: usage?.basis });
    if (row.state === 'rotate_pending') this.audit({ event: 'controller.rotate_requested', at: Date.now(), role: row.role, controllerId: id, generation: row.generation,
      reason: 'usage_80', bindingDigest: this.bindingDigest(row.conversation_scope) });
  }
  fail(id: string): void {
    this.store.db.prepare("UPDATE controller_sessions SET state='failed',updated_at=? WHERE controller_id=? AND state IN ('creating','running')").run(Date.now(), id);
  }
}
