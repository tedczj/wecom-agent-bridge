import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { parseLiveSpecification } from '../live/spec.ts';
import { blockedCase, caseStatus, finalizeCase } from '../live/report.ts';
import { verifyCaseEvidence } from '../live/evidence.ts';
import { setup } from '../helpers.ts';
import { sha256 } from '../../src/orchestration/requests.ts';

const specification = () => parseLiveSpecification(JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/live-cases.json', 'utf8')));
test('OFFLINE live specification: all 33 cases, 145 assertions and five global invariants remain traceable', () => {
  const spec = specification();
  assert.equal(spec.cases.length, 33); assert.equal(spec.cases.reduce((n, c) => n + c.assertions.length, 0), 145); assert.equal(spec.globalAssertions.length, 5);
  for (const c of spec.cases) {
    const result = blockedCase(c, 1, spec.globalAssertions, 'CONTROLLER_CAPABILITY_REQUIRED');
    assert.equal(result.status, 'BLOCKED'); assert.equal(result.assertions.length, c.assertions.length + 5);
    assert.ok(result.assertions.every(a => a.status === 'BLOCKED'));
  }
});
test('OFFLINE live reports: missing evidence, missing assertions and NOT_RUN never become PASS', () => {
  const spec = specification(), c = spec.cases[0]!, blocked = blockedCase(c, 1, spec.globalAssertions, 'missing');
  assert.throws(() => finalizeCase(c, 1, spec.globalAssertions, blocked.assertions.slice(1)), /LIVE_ASSERTION_COVERAGE/);
  assert.throws(() => caseStatus([{ id: 'test', predicate: 'p', expected: 'true', status: 'PASS' }]), /LIVE_PASS_WITHOUT_EVIDENCE/);
  assert.equal(caseStatus([{ id: 'test', predicate: 'p', expected: 'true', status: 'NOT_RUN' }]), 'NOT_RUN');
  assert.equal(caseStatus([{ id: 'test', predicate: 'p', expected: 'true', status: 'FAIL' }]), 'FAIL');
  assert.throws(() => caseStatus([{ id: 'pass', predicate: 'p', expected: 'true', status: 'PASS' },
    { id: 'block', predicate: 'b', expected: 'true', status: 'BLOCKED' }]), /LIVE_PASS_WITHOUT_EVIDENCE/);
  const replacedPredicate = structuredClone(blocked.assertions); replacedPredicate[0]!.predicate = 'easier-check';
  assert.throws(() => finalizeCase(c, 1, spec.globalAssertions, replacedPredicate), /LIVE_ASSERTION_COVERAGE/);
  const replacedExpectation = structuredClone(blocked.assertions); replacedExpectation[0]!.expected = 'weaker requirement';
  assert.throws(() => finalizeCase(c, 1, spec.globalAssertions, replacedExpectation), /LIVE_ASSERTION_COVERAGE/);
});
test('OFFLINE live specification: frozen rule changes and duplicate IDs are rejected', () => {
  const raw = JSON.parse(readFileSync('docs/plans/three-layer-agent-bridge/live-cases.json', 'utf8'));
  raw.frozenRules.rewriteUserQuery = true;
  assert.throws(() => parseLiveSpecification(raw), /LIVE_FROZEN_RULE/);
  raw.frozenRules.rewriteUserQuery = false; raw.cases[1].id = raw.cases[0].id;
  assert.throws(() => parseLiveSpecification(raw), /LIVE_CASE_ID/);
});
test('OFFLINE live evidence: PASS requires nonempty controlled files and records their hashes', async t => {
  const f = setup(t), spec = specification(), c = spec.cases[0]!;
  const bytes = '{"observed":true}\n'; writeFileSync(path.join(f.root, 'observation.json'), bytes);
  const result = blockedCase(c, 1, spec.globalAssertions, 'not executed');
  result.assertions[0] = { ...result.assertions[0]!, status: 'PASS', evidence: ['observation.json'] };
  const verified = await verifyCaseEvidence(result, f.root);
  assert.equal(verified.status, 'BLOCKED');
  assert.deepEqual(verified.assertions[0]!.evidenceSha256, { 'observation.json': sha256(bytes) });
  writeFileSync(path.join(f.root, 'empty.json'), ''); symlinkSync(path.join(f.root, 'observation.json'), path.join(f.root, 'linked.json'));
  for (const file of ['missing.json', 'empty.json', 'linked.json', '../observation.json', '/tmp/observation.json']) {
    const bad = structuredClone(result); bad.assertions[0]!.evidence = [file];
    const checked = await verifyCaseEvidence(bad, f.root);
    assert.equal(checked.status, 'FAIL'); assert.equal(checked.assertions[0]!.status, 'FAIL');
    assert.equal(checked.failureCode, 'LIVE_EVIDENCE_UNVERIFIED');
  }
});
