#!/usr/bin/env python3
"""Offline specification self-check; NEVER invokes models, network, Git or product runtime."""
from __future__ import annotations
import json
import re
import sqlite3
import sys
from pathlib import Path


def main() -> None:
    try:
        from jsonschema import Draft202012Validator
    except ImportError as exc:
        raise SystemExit('BLOCKED: jsonschema is required; schema validation was not run') from exc
    root = Path(__file__).resolve().parent
    spec = json.loads((root / 'live-cases.json').read_text(encoding='utf-8'))
    schema = json.loads((root / 'live-cases.schema.json').read_text(encoding='utf-8'))
    Draft202012Validator.check_schema(schema)
    Draft202012Validator(schema).validate(spec)
    cases = spec['cases']
    ids = [case['id'] for case in cases]
    expected_ids = {f'LIVE-{n:02}' for n in range(31)} | {'LIVE-W01', 'LIVE-W02'}
    assert len(ids) == len(set(ids)) == 33 and set(ids) == expected_ids
    assertions = [a['id'] for c in cases for a in c['assertions']]
    assert len(assertions) == len(set(assertions)) == 145
    assert all(c['status'] == 'NOT_RUN' for c in cases)
    assert spec['implementationStatus'] == 'SPECIFICATION_ONLY_RUNNER_TO_BE_IMPLEMENTED'
    for c in cases:
        assert [s['order'] for s in c['steps']] == list(range(1, len(c['steps'])+1))
        assert c['setup'] and c['steps'] and c['assertions'] and c['evidence']
    md = (root / 'LIVE_LLM_CASES.md').read_text(encoding='utf-8')
    assert all(md.count(f'### {cid} —') == 1 for cid in ids)
    assert all(md.count(f'| {aid} |') == 1 for aid in assertions)
    assert len(re.findall(r'^\| OFF-\d{2} \|', md, flags=re.M)) == 16
    config = json.loads((root/'config.hierarchical.example.json').read_text(encoding='utf-8'))
    orch = config['orchestration']
    assert orch['rotation']['thresholdNumerator'] == 4
    assert orch['rotation']['thresholdDenominator'] == 5
    assert orch['rotation']['usageSource'] == 'runtime-only'
    assert orch['query']['injectHistoricalContext'] is False
    assert orch['query']['mode'] == 'verbatim'
    assert orch['answers']['bridgeCanReadOriginal'] is False
    assert config['models']['daily']['contextWindowTokens'] == 1000000
    assert config['codex']['sandbox'] == 'read-only'
    assert all(not isinstance(v, str) or '\ufffd' not in v for v in [md])
    for f in root.rglob('*'):
        if f.is_file() and f.suffix in {'.md','.json','.sql','.mjs','.py'}:
            text = f.read_text(encoding='utf-8')
            assert '\ufffd' not in text, f'Unexpected replacement character: {f.name}'

    db = sqlite3.connect(':memory:')
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript('CREATE TABLE jobs(task_id TEXT PRIMARY KEY);CREATE TABLE sessions(session_key TEXT PRIMARY KEY);')
    ddl = (root/'schema-v4-reference.sql').read_text(encoding='utf-8')
    db.executescript(ddl)
    db.executescript(ddl)  # schema creation is idempotent, not a full data migration
    tables = {r[0] for r in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    added = tables - {'jobs','sessions','sqlite_sequence'}
    assert len(added) == 8
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    sql = '''INSERT INTO controller_sessions(controller_id,logical_key,conversation_scope,role,
    directory_identity,generation,is_current,state,runtime_kind,model_profile_digest,created_at,updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)'''
    db.execute(sql, ('r1','key-A','scope-A','route','dir-A',0,1,'ready','codex-app-server','profile',1,1))
    refused = 0
    for row in [
        ('r2','key-A','scope-A','route','dir-A',1,1,'ready','codex-app-server','profile',1,1),
        ('r3','key-B','scope-A','route',None,0,0,'creating','codex-app-server','profile',1,1),
        ('b1','key-C','scope-A','bridge','dir-A',0,0,'creating','codex-app-server','profile',1,1),
    ]:
        try:
            db.execute(sql, row)
        except sqlite3.IntegrityError:
            refused += 1
        else:
            raise AssertionError('DDL accepted invalid current/role scope')
    assert refused == 3
    assert db.execute('PRAGMA user_version').fetchone()[0] == 0
    db.close()
    report = {
        'status':'PASS',
        'scope':'DESIGN_BUNDLE_OFFLINE_VALIDATION_ONLY',
        'baselineCommit':spec['baselineCommit'],
        'checks':{
            'jsonSchema':'PASS','caseAndAssertionIds':'PASS','markdownJsonConsistency':'PASS',
            'fixed80AndVerbatimConfig':'PASS','referenceDdlInMemory':'PASS',
            'referenceDdlUniqueCurrentAndRoleConstraints':'PASS','utf8Files':'PASS'
        },
        'counts':{'liveCases':len(cases),'caseAssertions':len(assertions),
                  'globalAssertions':len(spec['globalAssertions']),'offlineContractGroups':16,
                  'referenceNewTables':len(added)},
        'productImplementation':'NOT_RUN', 'repositoryNpmCheck':'NOT_RUN',
        'liveLlmCases':'NOT_RUN','real1M80Percent':'NOT_RUN','liveWeixin':'NOT_RUN',
        'notes':['DDL tested only with minimal in-memory v3 placeholder tables.',
                 'This report is not evidence of installed runtime, model capability or production migration.']
    }
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__ == '__main__':
    main()
