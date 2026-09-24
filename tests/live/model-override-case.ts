import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Config } from '../../src/config.ts';
import type { NormalizedInput } from '../../src/types.ts';
import { ControllerFactory } from '../../src/controllers/factory.ts';
import { CodexAppServer } from '../../src/controllers/codex-app-server.ts';
import { modelDigest } from '../../src/orchestration/config.ts';
import { Catalog } from '../../src/routing/catalog.ts';
import { invariant, errorCode } from '../../src/errors.ts';
import { sha256 } from '../../src/orchestration/requests.ts';
import { liveFixture } from './fixture.ts';
import { nativeContextAudit, type NativeInputAudit } from './native-context.ts';
import { bridgeDisclosure } from './bridge-disclosure.ts';
import { replayEvidence } from './replay.ts';
import { finalizeCase, type AssertionResult, type CaseResult } from './report.ts';
import type { LiveCase } from './spec.ts';

export async function runModelOverrideCase(base: Config, test: LiveCase, attempt: number, globals: string[], output: string): Promise<CaseResult> {
  invariant(test.id === 'LIVE-05' && base.orchestration && base.models, 'LIVE_SCENARIO_UNSUPPORTED');
  const daily = base.models[base.orchestration.business.defaultModelProfile]!, management = base.models[base.orchestration.bridge.modelProfile]!;
  const alternate = Object.entries(base.models).find(([, model]) => model.model !== daily.model);
  invariant(alternate, 'LIVE_DISTINCT_BUSINESS_MODEL_NOT_CONFIGURED');
  // Validate the alternate proof without creating a manager or changing the fixture's management profile.
  await ControllerFactory.open({ ...base, orchestration: { ...base.orchestration,
    bridge: { ...base.orchestration.bridge, modelProfile: alternate[0] }, answers: { ...base.orchestration.answers, recapModelProfile: alternate[0] } } });
  const fixture = await liveFixture(base, output), { service, c } = fixture, originalRun = CodexAppServer.prototype.run;
  const observed: Array<{ threadId: string; turnId: string; model: unknown; reasoning: unknown; policyVerified: boolean }> = [];
  const metered: typeof originalRun = async function (this: CodexAppServer, ...args) {
    const result = await originalRun.apply(this, args), profile = this.observations.at(-1);
    observed.push({ threadId: args[0].threadId, turnId: result.turnId, model: profile?.model, reasoning: profile?.reasoning, policyVerified: result.policyVerified === true });
    return result;
  };
  CodexAppServer.prototype.run = metered;
  const observations: Record<string, { pass: boolean; actual: unknown }> = {};
  let failure: string | undefined, cleanupConfirmed = false;
  const observe = (predicate: string, pass: boolean, actual: unknown) => { observations[predicate] = { pass, actual }; };
  try {
    const ids: string[] = [], actualQueries: string[] = [];
    for (const step of test.steps) {
      const query = step.detail.replaceAll('${alternateLabel}', `${alternate[0]}（${alternate[1].model} / ${alternate[1].reasoning}）`); actualQueries.push(query);
      const accepted = await service.accept({ id: randomUUID(), session: 'fixture', text: query, images: [] });
      invariant(accepted.taskId && !accepted.rejected, 'LIVE_REQUEST_REJECTED'); ids.push(accepted.taskId); await service.settle();
      invariant(service.store.get(accepted.taskId).kind === 'agent' && service.store.get(accepted.taskId).status === 'succeeded', 'LIVE_BUSINESS_NOT_COMPLETED');
    }
    const jobs = ids.map(id => service.store.get(id)), inputs = jobs.map(job => JSON.parse(job.input_json) as NormalizedInput), native: NativeInputAudit[] = [];
    for (const job of jobs) native.push(await nativeContextAudit(service.store, c, job, 'unused-model-audit-marker'));
    const controllers = service.store.db.prepare('SELECT role,native_ref_json,model_profile_digest FROM controller_sessions').all();
    const managementStable = controllers.length >= 3 && controllers.every(row => {
      const threadId = JSON.parse(row.native_ref_json as string).threadId;
      const turns = observed.filter(turn => turn.threadId === threadId);
      return row.model_profile_digest === modelDigest(management) && turns.length > 0 && turns.every(turn => turn.model === management.model && turn.reasoning === management.reasoning && turn.policyVerified);
    });
    observe('modelOverrideScope', inputs[0]?.workspaceId === 'term4u' && inputs[0].routing?.execution?.model === alternate[1].model &&
      native[0]?.runtimeProfile?.model === alternate[1].model && native[0].runtimeProfile.reasoning === alternate[1].reasoning && managementStable,
      { alternate, business: native[0]?.runtimeProfile, management, observed, controllers, specificationOverride: 'operator-selected gpt-6-sol/medium management profile' });
    observe('defaultFallbackOnlyWhenUnspecified', inputs[1]?.workspaceId === 'doc-ocr-service' && inputs[1].routing?.execution?.model === daily.model &&
      inputs[1].routing.modelSource === 'daily' && native[1]?.runtimeProfile?.model === daily.model && native[1].runtimeProfile.reasoning === daily.reasoning,
      { default: daily, input: inputs[1]?.routing, native: native[1]?.runtimeProfile, firstRequestOnly: true });
    observe('profileDigestAndSource', inputs[0]?.routing?.modelSource === 'request' && inputs[0].routing.modelSources?.model === 'request' &&
      inputs[1]?.routing?.modelSources?.model === 'daily' && jobs.every(job => !service.store.value('session-model:' + job.session_key)) &&
      inputs.every((input, i) => !!input.routing && new Catalog(c).target(input.routing.directory, input.routing.execution).digest === input.routing.digest &&
        !!native[i]?.observedContextWindows?.length && native[i]!.observedContextWindows!.every(window => window === input.routing!.execution?.contextWindowTokens)),
      inputs.map((input, i) => ({ modelProfile: input.routing?.modelProfile, source: input.routing?.modelSource, sources: input.routing?.modelSources,
        digest: input.routing?.digest, observedWindows: native[i]?.observedContextWindows, mapping: service.store.value('business-context-window:' + ids[i]) })));
    const wires = ids.map((id, i) => ({ expected: sha256(actualQueries[i]!), source: service.store.db.prepare('SELECT raw_query_sha256 FROM orchestration_requests WHERE request_id=?').get(id)!.raw_query_sha256,
      values: ['controller-wire:bridge:', 'controller-wire:route:', 'business-wire:'].map(prefix => service.store.value<{ textSha256: string }>(prefix + id)?.textSha256) }));
    observe('rawQueryMatchesSourceRequest', wires.every(row => row.expected === row.source && row.values.every(value => value === row.source)), wires);
    observe('permissionScopeValid', c.codex.sandbox === 'read-only' && !c.codex.networkAccess && inputs.every(input => ['term4u', 'doc-ocr-service'].includes(input.workspaceId)),
      { sandbox: c.codex.sandbox, modelOverrideChangesPermissions: false, notOsIsolation: true });
    const disclosure = bridgeDisclosure(service.store, ids), replay = replayEvidence(service.store, ids);
    if (disclosure.complete) observe('noBridgeRawAnswerDisclosure', disclosure.pass, disclosure.actual);
    if (replay.complete) observe('noBusinessReplayAfterUncertain', replay.pass, replay.actual);
    fixture.save('model-observations.json', { observed, controllers, nativeProfiles: native.map(row => row.runtimeProfile),
      alternateProofSha256: sha256(readFileSync(path.join(base.orchestration.controllerRuntime.workRoot, 'runtime-lock-' + modelDigest(alternate[1]) + '.json'))) });
    fixture.save('profile-resolution.json', observations.profileDigestAndSource); fixture.save('native-turn-context.json', native);
  } catch (error) { failure = errorCode(error, 'LIVE_CASE_FAILED'); }
  finally {
    try { await fixture.close(); cleanupConfirmed = true; } catch (error) { failure = errorCode(error, 'LIVE_CLEANUP_FAILED'); }
    if (CodexAppServer.prototype.run === metered) CodexAppServer.prototype.run = originalRun;
    else { cleanupConfirmed = false; failure = 'LIVE_METER_RESTORE_CONFLICT'; }
    fixture.save('observations.json', observations);
  }
  const assertions: AssertionResult[] = [...test.assertions, ...globals.map(predicate => ({ id: test.id + '-GLOBAL-' + predicate, predicate, expected: 'true' }))].map(a => {
    const observed = observations[a.predicate]; return observed ? { ...a, status: observed.pass ? 'PASS' : 'FAIL', actual: observed.actual, evidence: ['observations.json'] }
      : { ...a, status: failure ? 'FAIL' : 'BLOCKED', reason: failure ?? 'PREDICATE_ORACLE_NOT_IMPLEMENTED' };
  });
  const result = finalizeCase(test, attempt, globals, assertions);
  return failure ? { ...result, status: 'FAIL', failureCode: failure, cleanupConfirmed } : { ...result, cleanupConfirmed };
}
