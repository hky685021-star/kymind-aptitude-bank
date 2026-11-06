#!/usr/bin/env python3
"""Build a read-only, bounded public projection. Never edits signed originals.

Explicit source order is oldest to newest; later batches replace the same question.
Hashes protect projection integrity, not authorship or correctness of AI content.
"""
import argparse
import hashlib
import json
from pathlib import Path
import re

ROOT = Path(__file__).resolve().parents[1]
AI_STATUSES = {'reviewed', 'needs-review', 'blocked'}
MODEL_STATUSES = {'reviewed', 'pending', 'quarantined'}
ISSUES = {'missing-image', 'missing-material', 'answer-conflict', 'source-unverified'}
DIMENSIONS = ('concept', 'model', 'target', 'context')
MAX_SHARD_BYTES = 4 * 1024 * 1024

def require(value, reason):
    if not value:
        raise ValueError(reason)

def text(value, limit=16000, empty=False):
    require(isinstance(value, str) and len(value) <= limit and (empty or value.strip()), 'invalid text')
    return value

def strings(value, count=32, limit=2000):
    require(isinstance(value, list) and len(value) <= count, 'invalid list')
    return [text(item, limit) for item in value]

def digest(data):
    return hashlib.sha256(data).hexdigest()

def encode(value):
    return (json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True) + '\n').encode()

def read(path, limit=32*1024*1024):
    require(path.is_file() and not path.is_symlink() and path.stat().st_size <= limit, f'invalid file: {path}')
    return path.read_bytes()

def batch(root, kind, batch_id, scope):
    require(re.fullmatch(r'[A-Za-z0-9_-]{1,100}', batch_id), 'invalid batch ID')
    directory = root / ('supplements/ai/batches' if kind == 'ai' else 'candidates/model-index') / batch_id
    require(not directory.is_symlink(), 'symlink batch directory')
    meta = json.loads(read(directory / 'batch.json', 1024*1024))
    require(meta['bankId'] == scope['bankId'] and meta['sourceReleaseId'] == scope['releaseId']
            and meta['sourceManifestHash'] == scope['manifestHash'], f'batch scope mismatch: {batch_id}')
    data = read(directory / 'records.jsonl')
    require(digest(data) == meta['recordsSha256'], f'record hash mismatch: {batch_id}')
    rows = [json.loads(line) for line in data.splitlines() if line.strip()]
    require(len(rows) == meta['recordCount'] and len(rows) <= 2000, 'batch count mismatch or budget')
    ids = set()
    for row in rows:
        key = row['key'] if kind == 'ai' else row
        require(re.fullmatch(r'q_[a-f0-9]{64}', key['questionId']) and key['questionId'] not in ids, 'invalid or duplicate question')
        require(re.fullmatch(r'[a-f0-9]{64}', key['revisionDigest']) and key['bankId'] == scope['bankId'], 'invalid question identity')
        ids.add(key['questionId'])
    source = {'kind': kind, 'batchId': batch_id, 'recordsSha256': digest(data), 'recordCount': len(rows)}
    dictionary = None
    if kind == 'models':
        data = read(directory / 'dictionary.json', 4*1024*1024)
        require(digest(data) == meta['dictionarySha256'], 'dictionary hash mismatch')
        dictionary = json.loads(data)
        require(dictionary['bankId'] == scope['bankId'] and dictionary['dictionaryVersion'] == meta['dictionaryVersion'], 'dictionary scope mismatch')
        source['dictionarySha256'] = digest(data)
    return rows, dictionary, source

def build(root, ai_batches, model_batches):
    entry = json.loads(read(root / 'original/bank-civil-aptitude/bank.json'))
    scope = {'bankId': entry['bankId'], 'releaseId': entry['currentRelease']['releaseId'],
             'manifestHash': entry['currentRelease']['manifestHash']}
    records, sources = {}, []
    # Build a map of declared source revisions, so an invalid sidecar never gets published.
    bank = root / 'original/bank-civil-aptitude'
    manifest = json.loads(read(bank / entry['currentRelease']['manifestPath'], 64*1024*1024))
    require(digest(read(bank / entry['currentRelease']['manifestPath'], 64*1024*1024)) == scope['manifestHash'], 'manifest hash mismatch')
    release = bank / 'releases' / scope['releaseId']
    revisions = {}
    for page in manifest['files']:
        if page['kind'] != 'web-index' or page['path'].endswith('/root.json'):
            continue
        require(re.fullmatch(r'web-index/[A-Za-z0-9._/-]+', page['path']) and '..' not in page['path'], 'invalid source path')
        data = read(release / page['path'])
        require(digest(data) == page['sha256'], 'web index hash mismatch')
        for item in json.loads(data)['items']:
            revisions[item['questionId']] = item['revisionDigest']
    for kind, batches in [('ai', ai_batches), ('models', model_batches)]:
        require(len(set(batches)) == len(batches), 'duplicate source batch')
        for batch_id in batches:
            rows, dictionary, source = batch(root, kind, batch_id, scope)
            sources.append(source)
            terms = {}
            if dictionary:
                for dimension in DIMENSIONS:
                    terms[dimension] = {}
                    for term in dictionary['dimensions'][dimension]:
                        code = text(term['code'], 200)
                        require(code not in terms[dimension], 'duplicate dictionary code')
                        require(term['reviewStatus'] in {'pending', 'reviewed'}, 'invalid term status')
                        terms[dimension][code] = {'code': code, 'label': text(term['label'], 200),
                            'definition': text(term['definition'], 2000), 'reviewStatus': term['reviewStatus']}
            for row in rows:
                identity = row['key'] if kind == 'ai' else row
                qid = identity['questionId']
                require(revisions.get(qid) == identity['revisionDigest'], f'stale source record: {qid}')
                key = {**scope, 'questionId': qid, 'revisionDigest': identity['revisionDigest']}
                record = records.setdefault(qid, {'key': key, 'ai': None, 'models': None})
                if kind == 'ai':
                    require(identity == key, 'AI scope mismatch')
                    require(row['reviewStatus'] in AI_STATUSES, 'invalid AI status')
                    issues = strings(row['sourceIssues'], 4, 40)
                    require(len(set(issues)) == len(issues) and set(issues) <= ISSUES, 'invalid source issues')
                    require(row['reviewStatus'] != 'reviewed' or not issues, 'reviewed AI has unresolved source issues')
                    record['ai'] = {'batchId': batch_id, 'focusAnalysis': text(row['focusAnalysis']),
                        'quickTip': text(row['quickTip']), 'sourceIssues': issues, 'reviewStatus': row['reviewStatus']}
                else:
                    require(row['dictionaryVersion'] == dictionary['dictionaryVersion'], 'record dictionary mismatch')
                    require(row['reviewStatus'] in MODEL_STATUSES, 'invalid model status')
                    dimensions = {}
                    for dimension in DIMENSIONS:
                        codes = strings(row[dimension + 'Codes'], 32, 200)
                        require(len(set(codes)) == len(codes) and all(code in terms[dimension] for code in codes), 'unknown or duplicate model code')
                        dimensions[dimension] = [terms[dimension][code] for code in codes]
                    evidence = row['evidence']
                    record['models'] = {'batchId': batch_id, 'dictionaryVersion': text(row['dictionaryVersion'], 200),
                        'knowledgeCategory': text(row['knowledgeCategory'], 200), 'reviewStatus': row['reviewStatus'],
                        'dimensions': dimensions, 'basis': text(evidence['basis']),
                        'pendingReasons': strings(evidence.get('pendingReasons', []))}
    shards = {}
    for qid, record in sorted(records.items()):
        shards.setdefault(qid[2:4], []).append(record)
    outputs, refs = {}, []
    for prefix, items in sorted(shards.items()):
        require(len(items) <= 2000, 'shard item budget')
        data = encode({'schemaVersion': 1, **scope, 'prefix': prefix, 'records': items})
        require(len(data) <= MAX_SHARD_BYTES, 'shard byte budget')
        sha = digest(data)
        path = f'v1/{prefix}-{sha}.json'
        outputs[path] = data
        refs.append({'prefix': prefix, 'path': path, 'sha256': sha, 'byteLength': len(data), 'recordCount': len(items)})
    index = {'schemaVersion': 1, **scope, 'recordCount': len(records), 'shards': refs, 'sources': sources}
    outputs['index.json'] = encode(index)
    require(len(outputs['index.json']) <= 256*1024, 'index byte budget')
    return outputs

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ai-batch', action='append', required=True, help='Oldest first; repeat to layer a newer batch')
    parser.add_argument('--model-batch', action='append', required=True)
    parser.add_argument('--check', action='store_true', help='Verify generated bytes without writing')
    args = parser.parse_args()
    outputs = build(ROOT, args.ai_batch, args.model_batch)
    target = ROOT / 'supplements/reader'
    for name, data in outputs.items():
        path = target / name
        if args.check:
            require(read(path) == data, f'projection differs: {name}')
        else:
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(data)
    # Keep older immutable shards so an already-open catalog can still load them.
    print(f'{"Verified" if args.check else "Built"} reader projection: {len(outputs)-1} shards, {json.loads(outputs["index.json"])["recordCount"]} questions')

if __name__ == '__main__':
    main()
