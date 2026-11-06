#!/usr/bin/env python3
"""Verify preserved signed source and the first unapproved review-data import."""
import collections
import hashlib
import json
import pathlib
import sys
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PublicKey

ROOT = pathlib.Path(__file__).resolve().parents[1]
BANK = ROOT / 'original/bank-civil-aptitude'
BATCH = '2026-11-06-seven-samples'

def read_json(path):
    return json.loads(path.read_bytes())

def sha256(path):
    with path.open('rb') as stream:
        return hashlib.file_digest(stream, 'sha256').hexdigest()

def safe_path(root, name):
    rel = pathlib.PurePosixPath(name)
    if rel.is_absolute() or '..' in rel.parts or '\\' in name:
        raise ValueError(f'Unsafe relative path: {name!r}')
    path = root.joinpath(*rel.parts)
    if path.is_symlink() or not path.is_relative_to(root):
        raise ValueError(f'Unsafe file: {name!r}')
    return path

def require(condition, message):
    if not condition:
        raise ValueError(message)

def verify_signature(document):
    unsigned = dict(document)
    signature = unsigned.pop('signature')
    require(signature['algorithm'] == 'ed25519', 'Unexpected signature algorithm')
    require(signature['keyId'] == unsigned['authorKeyId'], 'Signature key ID mismatch')
    message = json.dumps(unsigned, ensure_ascii=False, sort_keys=True, separators=(',', ':')).encode('utf-8')
    Ed25519PublicKey.from_public_bytes(bytes.fromhex(unsigned['authorPublicKeyHex'])).verify(bytes.fromhex(signature['valueHex']), message)

def main():
    transfer = read_json(ROOT / 'provenance/transfer-manifest.json')
    expected_paths = set()
    digests = {}
    total_bytes = 0
    for entry in transfer['files']:
        name = entry['path']
        require(name not in expected_paths, f'Duplicate transfer path: {name}')
        expected_paths.add(name)
        path = safe_path(BANK, name)
        require(path.is_file(), f'Missing source file: {name}')
        size = path.stat().st_size
        require(size == entry['byteLength'], f'Source length mismatch: {name}')
        digest = sha256(path)
        require(digest == entry['sha256'], f'Source SHA256 mismatch: {name}')
        digests[name] = digest
        total_bytes += size
    actual_paths = {p.relative_to(BANK).as_posix() for p in BANK.rglob('*') if p.is_file()}
    require(actual_paths == expected_paths, 'Original tree differs from the transfer manifest')
    require(len(expected_paths) == transfer['summary']['fileCount'] == 51054, 'Original file count mismatch')
    require(total_bytes == transfer['summary']['uncompressedBytes'] == 699118078, 'Original byte count mismatch')
    print(f'Original files: {len(expected_paths)} verified, {total_bytes} bytes', flush=True)

    bank = read_json(BANK / 'bank.json')
    current = bank['currentRelease']
    manifest_path = safe_path(BANK, current['manifestPath'])
    manifest = read_json(manifest_path)
    require(sha256(manifest_path) == current['manifestHash'], 'Entry/manifest hash mismatch')
    require(bank['bankId'] == manifest['bankId'] == 'bank-civil-aptitude', 'Bank identity mismatch')
    require(current['releaseId'] == manifest['releaseId'], 'Release identity mismatch')
    verify_signature(bank)
    verify_signature(manifest)
    release_root = manifest_path.parent
    manifest_files = set()
    for entry in manifest['files']:
        path = safe_path(release_root, entry['path'])
        relative = path.relative_to(BANK).as_posix()
        require(entry['path'] not in manifest_files, 'Duplicate signed manifest path')
        manifest_files.add(entry['path'])
        require(digests.get(relative) == entry['sha256'], f'Signed hash mismatch: {relative}')
        require(path.stat().st_size == entry['byteLength'], f'Signed length mismatch: {relative}')
    require(len(manifest_files) == transfer['summary']['declaredFileCount'] == 50990, 'Signed file count mismatch')
    print('Entry and release Ed25519 signatures: verified; signed files: 50990', flush=True)

    ai_dir = ROOT / 'supplements/ai/batches' / BATCH
    model_dir = ROOT / 'candidates/model-index' / BATCH
    ai = [json.loads(line) for line in (ai_dir / 'records.jsonl').read_text().splitlines() if line]
    models = [json.loads(line) for line in (model_dir / 'records.jsonl').read_text().splitlines() if line]
    selection = read_json(ai_dir / 'selection.json')
    selected_ids = {row['questionId'] for row in selection}
    require(len(selected_ids) == len(selection) == len(ai) == len(models) == 7, 'Review sample count mismatch')
    require({row['key']['questionId'] for row in ai} == selected_ids, 'AI sample IDs mismatch')
    require({row['questionId'] for row in models} == selected_ids, 'Model sample IDs mismatch')
    question_ids = set()
    selected_questions = {}
    for shard in manifest['questionShards']:
        count = 0
        with safe_path(release_root, shard['path']).open(encoding='utf-8') as stream:
            for line in stream:
                if not line.strip():
                    continue
                question = json.loads(line)
                qid = question['questionId']
                require(qid not in question_ids, f'Duplicate question ID: {qid}')
                question_ids.add(qid)
                require(question['bankId'] == bank['bankId'], 'Question bank mismatch')
                if qid in selected_ids:
                    selected_questions[qid] = question
                count += 1
        require(count == shard['questionCount'], f'Question shard count mismatch: {shard["path"]}')
    require(len(question_ids) == manifest['questionCount'] == 70575, 'Total question count mismatch')
    require(set(selected_questions) == selected_ids, 'Missing selected original questions')

    ai_status = collections.Counter()
    for row in ai:
        key = row['key']
        require(key['bankId'] == bank['bankId'], 'AI bank mismatch')
        require(key['releaseId'] == current['releaseId'], 'AI release mismatch')
        require(key['manifestHash'] == current['manifestHash'], 'AI manifest mismatch')
        require(key['revisionDigest'] == selected_questions[key['questionId']]['revisionDigest'], 'AI question revision mismatch')
        require(row['reviewStatus'] in {'needs-review', 'blocked'}, 'Initial AI batch was promoted without updating provenance')
        ai_status[row['reviewStatus']] += 1
    require(ai_status == {'needs-review': 6, 'blocked': 1}, 'Initial AI review states changed')
    model_status = collections.Counter()
    for row in models:
        require(row['bankId'] == bank['bankId'], 'Model bank mismatch')
        require(row['revisionDigest'] == selected_questions[row['questionId']]['revisionDigest'], 'Model question revision mismatch')
        require(row['reviewStatus'] == 'pending', 'Unapproved model candidate status changed')
        model_status[row['reviewStatus']] += 1
    ai_batch = read_json(ai_dir / 'batch.json')
    require(ai_batch['recordCount'] == 7 and ai_batch['reviewedCount'] == 0, 'AI batch count mismatch')
    require(sha256(ai_dir / 'records.jsonl') == ai_batch['recordsSha256'], 'AI batch checksum mismatch')
    model_batch = read_json(model_dir / 'batch.json')
    require(model_batch['recordCount'] == model_batch['pendingCount'] == 7 and model_batch['reviewedCount'] == 0, 'Model batch count mismatch')
    require(sha256(model_dir / 'records.jsonl') == model_batch['recordsSha256'], 'Model records checksum mismatch')
    require(sha256(model_dir / 'dictionary.json') == model_batch['dictionarySha256'], 'Model dictionary checksum mismatch')
    imported = read_json(ROOT / 'provenance/review-import-manifest.json')
    for entry in imported['files']:
        path = safe_path(ROOT, entry['path'])
        require(path.stat().st_size == entry['byteLength'] and sha256(path) == entry['sha256'], f'Imported review file changed: {entry["path"]}')
    print('Questions: 70575 unique; initial AI states: 6 needs-review, 1 blocked; model states: 7 pending', flush=True)
    print('Review import byte preservation: verified', flush=True)
    print('Known source issue: 1 PNG decode anomaly recorded in the original transfer manifest; not silently repaired.')
    print('PASS: package integrity and initial batch provenance. This is not full content approval or image/UI acceptance.')

if __name__ == '__main__':
    try:
        main()
    except Exception as exc:
        print(f'FAIL: {type(exc).__name__}: {exc}', file=sys.stderr)
        sys.exit(1)
