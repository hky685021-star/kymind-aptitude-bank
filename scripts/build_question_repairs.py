#!/usr/bin/env python3
"""Build verified repair sidecars without changing originals. Batches: oldest first."""
import argparse
import json
from pathlib import Path, PurePosixPath
import re
from build_reader_supplements import require, text as base_text, digest, encode, read, MAX_SHARD_BYTES, ISSUES
from verify_repository import verify_signature

ROOT = Path(__file__).resolve().parents[1]
HOLDS = {'answer-conflict', 'missing-material', 'missing-image', 'source-unverified'}
ISSUE_LABELS = {'answer-conflict': '答案冲突', 'missing-material': '缺材料', 'missing-image': '缺图片', 'source-unverified': '来源待核验'}

def text(value, limit=16000):
    base_text(value, limit)
    require(len(value.encode('utf-16-le')) // 2 <= limit, 'text UTF16 budget')
    return value

def strings(value, count=32, limit=2000):
    require(isinstance(value, list) and len(value) <= count, 'invalid list')
    return [text(item, limit) for item in value]

def safe(root, name):
    require(isinstance(name, str) and 0 < len(name) <= 500 and '\\' not in name, 'invalid path')
    rel = PurePosixPath(name)
    require(not rel.is_absolute() and all(p not in {'.', '..'} for p in name.split('/')), 'invalid path')
    path = root
    for part in rel.parts:
        path = path / part
        require(not path.is_symlink(), 'symlink path')
    return path

class Source:
    def __init__(self, root):
        bank = safe(root, 'original/bank-civil-aptitude')
        entry = json.loads(read(safe(bank, 'bank.json')))
        verify_signature(entry)
        current = entry['currentRelease']
        self.scope = {'bankId': entry['bankId'], 'releaseId': current['releaseId'], 'manifestHash': current['manifestHash']}
        manifest_path = safe(bank, current['manifestPath'])
        data = read(manifest_path, 64*1024*1024)
        require(digest(data) == current['manifestHash'], 'manifest hash mismatch')
        manifest = json.loads(data)
        verify_signature(manifest)
        require(manifest['bankId'] == entry['bankId'] and manifest['releaseId'] == current['releaseId'] and manifest['authorPublicKeyHex'] == entry['authorPublicKeyHex'], 'manifest identity mismatch')
        self.manifest = manifest
        self.collection_kinds = {}
        self.release = manifest_path.parent
        self.files = {}
        require(len(manifest['files']) <= 100000, 'manifest budget')
        for f in manifest['files']:
            safe(self.release, f['path'])
            require(f['path'] not in self.files, 'duplicate manifest path')
            self.files[f['path']] = f
        self.index, self.collections, self.cache = {}, {}, {}
        for f in self.files.values():
            if f['kind'] == 'web-index' and not f['path'].endswith('/root.json'):
                page = json.loads(self.file(f['path'], 'web-index'))
                require(page['bankId'] == self.scope['bankId'] and page['releaseId'] == self.scope['releaseId'], 'index scope mismatch')
                for item in page['items']:
                    qid = item['questionId']
                    require(re.fullmatch(r'q_[a-f0-9]{64}', qid) and qid not in self.index, 'duplicate or invalid index question')
                    self.index[qid] = item
            if f['kind'] == 'collection':
                for line in self.file(f['path'], 'collection').splitlines():
                    if not line.strip(): continue
                    c = json.loads(line)
                    require(c['bankId'] == self.scope['bankId'] and c['collectionId'] not in self.collections, 'collection scope mismatch')
                    self.collection_kinds[c['collectionId']] = c['kind']
                    self.collections[c['collectionId']] = {r['questionId'] for r in c['orderedQuestionRefs'] if r['bankId'] == self.scope['bankId']}
        require(len(self.index) <= 200000, 'index budget')

    def file(self, name, kind):
        f = self.files.get(name)
        require(f is not None and f['kind'] == kind, 'undeclared source file kind')
        data = read(safe(self.release, name), 32*1024*1024)
        require(len(data) == f['byteLength'] and digest(data) == f['sha256'], 'source file hash mismatch')
        return data

    def question(self, qid, revision=None, source_file=None):
        item = self.index.get(qid)
        require(item is not None, 'unknown source question')
        name = item['shardPath']
        require(source_file is None or source_file == name, 'source file/index mismatch')
        if name not in self.cache:
            rows = {}
            for line in self.file(name, 'question').splitlines():
                if not line.strip(): continue
                require(len(line) <= 2*1024*1024, 'question byte budget')
                q = json.loads(line)
                require(q['questionId'] not in rows, 'duplicate source question')
                rows[q['questionId']] = q
            require(len(rows) <= 10000, 'question file count budget')
            # Keep at most one question file resident; banks may contain hundreds.
            self.cache.clear()
            self.cache[name] = rows
        q = self.cache[name].get(qid)
        require(q is not None and q['bankId'] == self.scope['bankId'] and q['revisionDigest'] == item['revisionDigest'], 'question/index mismatch')
        require(revision is None or revision == q['revisionDigest'], 'stale revision')
        unsigned = dict(q); unsigned.pop('revisionDigest')
        require(digest(encode(unsigned).rstrip(b'\n')) == q['revisionDigest'], 'question canonical digest mismatch')
        require(q['type'] == item['type'] and q['review']['practiceEligible'] == item['practiceEligible'], 'question index identity mismatch')
        return q

    def key(self, key):
        q = self.question(key['questionId'], key['revisionDigest'])
        require(key == {**self.scope, 'questionId': q['questionId'], 'revisionDigest': q['revisionDigest']}, 'record scope mismatch')
        return q

def load_batch(root, kind, batch_id, scope):
    require(isinstance(batch_id, str) and re.fullmatch(r'[A-Za-z0-9_-]{1,100}', batch_id), 'invalid batch ID')
    directory = safe(root, f'supplements/{kind}/batches/{batch_id}')
    meta = json.loads(read(safe(directory, 'batch.json'), 1024*1024))
    require(meta['bankId'] == scope['bankId'] and meta['sourceReleaseId'] == scope['releaseId'] and meta['sourceManifestHash'] == scope['manifestHash'], 'batch scope mismatch')
    data = read(safe(directory, 'records.jsonl'))
    require(digest(data) == meta['recordsSha256'], 'batch hash mismatch')
    rows = [json.loads(line) for line in data.splitlines() if line.strip()]
    require(len(rows) == meta['recordCount'] and len(rows) <= 2000, 'batch record budget')
    require(len({r['key']['questionId'] for r in rows}) == len(rows), 'duplicate batch question')
    return rows, {'kind': kind, 'batchId': batch_id, 'recordsSha256': digest(data), 'recordCount': len(rows)}

def option_ids(value):
    ids = strings(value, 100, 100)
    require(len(ids) == len(set(ids)), 'duplicate option IDs')
    return ids

def validate_material(source, question, indexes):
    """Mirror selectMaterialBody and verify every selected image's signed bytes."""
    require(question['review'].get('practiceEligible') is True and question['review'].get('status') != 'quarantined', 'material source quarantined')
    stem = question['stem']
    require(stem.get('format') == 'tiptap-portable-v1' and stem.get('doc', {}).get('type') == 'doc' and isinstance(stem['doc'].get('content'), list), 'invalid material stem')
    content = stem['doc']['content']
    blocks = content if indexes is None else [content[i] for i in indexes]
    stack = [(node, 0) for node in blocks]
    count = characters = 0
    selected = set()
    while stack:
        node, depth = stack.pop(); count += 1
        require(isinstance(node, dict) and count <= 20000 and depth <= 64, 'material node budget')
        if node.get('type') == 'text':
            require(isinstance(node.get('text'), str), 'invalid material text')
            characters += len(node['text'].encode('utf-16-le')) // 2
            require(characters <= 200000, 'material text budget')
        if node.get('type') == 'questionImage':
            occurrence_id = text(node.get('attrs', {}).get('occurrenceId'), 200)
            require(occurrence_id not in selected, 'duplicate selected image occurrence')
            selected.add(occurrence_id)
        if 'content' in node:
            require(isinstance(node['content'], list), 'invalid material children')
            stack.extend((child, depth+1) for child in node['content'])
    require(len(selected) <= 32, 'material image budget')
    total = 0
    for occurrence_id in selected:
        occurrences = [o for o in question.get('mediaOccurrences', []) if o.get('occurrenceId') == occurrence_id and o.get('zone') == 'stem']
        require(len(occurrences) == 1 and occurrences[0].get('status') == 'ready', 'material image not ready')
        media = [m for m in source.manifest.get('media', []) if m.get('mediaId') == occurrences[0].get('mediaId')]
        require(len(media) == 1 and media[0].get('mimeType') in {'image/png', 'image/jpeg', 'image/bmp'}, 'material image not declared')
        m = media[0]
        require(type(m.get('byteLength')) is int and m['byteLength'] > 0, 'invalid image size')
        total += m['byteLength']
        require(total <= 16*1024*1024, 'material image byte budget')
        data = source.file(m['path'], 'media')
        require(len(data) == m['byteLength'] and digest(data) == m['sha256'] and m['mediaId'] == 'media_' + m['sha256'], 'material media hash mismatch')
    return len(selected), total

def validate_repair(row, source, batch_id):
    require(row['schemaVersion'] == 1, 'repair schema mismatch')
    q = source.key(row['key'])
    status = row['reviewStatus']
    require(status in {'reviewed', 'needs-review', 'blocked'}, 'invalid review status')
    links = row['materialLinks']
    require(isinstance(links, list) and len(links) <= 8, 'material links budget')
    checked, identities = [], set()
    image_count = image_bytes = 0
    for link in links:
        require(link['sourceQuestionId'] != q['questionId'], 'self material link')
        require(re.fullmatch(r'questions/[a-zA-Z0-9._-]+\.jsonl', link['sourceFile']), 'invalid source question path')
        identity = (link['sourceQuestionId'], None if link['stemBlockIndexes'] is None else tuple(link['stemBlockIndexes']))
        require(identity not in identities, 'duplicate material link')
        identities.add(identity)
        src = source.question(link['sourceQuestionId'], link['sourceRevisionDigest'], link['sourceFile'])
        cid = text(link['collectionId'], 200)
        require(source.collection_kinds.get(cid) == 'paper', 'material collection must be paper')
        members = source.collections.get(cid, set())
        require(q['questionId'] in members and src['questionId'] in members, 'material collection membership mismatch')
        require(cid in source.index[q['questionId']]['collectionIds'] and cid in source.index[src['questionId']]['collectionIds'], 'material index collection mismatch')
        indexes = link['stemBlockIndexes']
        blocks = src['stem']['doc']['content']
        if indexes is not None:
            require(isinstance(indexes, list) and 0 < len(indexes) <= 128 and all(type(i) is int and 0 <= i < len(blocks) for i in indexes) and indexes == sorted(set(indexes)), 'invalid material block indexes')
        count, size = validate_material(source, src, indexes)
        image_count += count; image_bytes += size
        require(image_count <= 32 and image_bytes <= 16*1024*1024, 'target image budget')
        checked.append({**{k: link[k] for k in ('sourceQuestionId', 'sourceRevisionDigest', 'sourceFile', 'collectionId')}, 'evidence': text(link['evidence']), 'stemBlockIndexes': indexes})
    correction = row['answerCorrection']
    if correction is not None:
        action = correction['action']
        require(action in {'replace', 'withhold', 'keep-original'}, 'invalid correction action')
        original = option_ids(correction['originalOptionIds'])
        require(set(original) == set(q['answer']['optionIds']), 'original answer mismatch')
        corrected = option_ids(correction['correctedOptionIds'])
        require(set(original) <= {o['optionId'] for o in q['options']}, 'invalid original option')
        evidence = strings(correction['evidence'], 32, 2000)
        require(evidence, 'correction requires evidence')
        reason = text(correction['reason'])
        if action == 'replace':
            require(status == 'reviewed' and evidence and corrected, 'replacement must be reviewed with evidence')
            require(q['answer'].get('grading') == 'objective', 'replacement requires objective grading')
            require(set(corrected) != set(original), 'replacement answer unchanged')
            valid = {o['optionId'] for o in q['options']}
            require(set(corrected) <= valid, 'unknown corrected option')
            require(q['type'] in {'single-choice', 'multiple-choice', 'true-false'}, 'unsupported answer correction type')
            require(q['type'] == 'multiple-choice' or len(corrected) == 1, 'invalid answer cardinality')
        else:
            require(not corrected, 'nonreplacement corrected options')
            require(action != 'keep-original' or (status == 'reviewed' and evidence), 'keeping original requires reviewed evidence')
        correction = {'action': action, 'originalOptionIds': original, 'correctedOptionIds': corrected, 'reason': reason, 'evidence': evidence}
    return {'schemaVersion': 1, 'key': row['key'], 'batchId': batch_id, 'reviewStatus': status, 'materialLinks': checked, 'answerCorrection': correction}

def build(root, repair_batches, ai_batches):
    root = Path(root)
    require(ai_batches and len(ai_batches) <= 200 and len(repair_batches) <= 200, 'batch budget or missing AI batches')
    source = Source(root)
    records, issues, issue_batches, sources = {}, {}, {}, []
    for kind, batches in [('ai', ai_batches), ('repairs', repair_batches)]:
        require(len(set(batches)) == len(batches), 'duplicate source batch')
        for batch_id in batches:
            rows, provenance = load_batch(root, kind, batch_id, source.scope)
            sources.append(provenance)
            for row in rows:
                q = source.key(row['key']); qid = q['questionId']
                if kind == 'ai':
                    names = strings(row['sourceIssues'], 4, 40)
                    require(len(set(names)) == len(names) and set(names) <= ISSUES, 'invalid AI source issues')
                    require(row['reviewStatus'] in {'reviewed', 'needs-review', 'blocked'} and (row['reviewStatus'] != 'reviewed' or not names), 'invalid AI review status')
                    issues[qid] = names
                    issue_batches[qid] = batch_id
                else:
                    record = validate_repair(row, source, batch_id)
                    require(not (records.get(qid, {}).get('answerCorrection') and record['answerCorrection'] is None), 'later null cannot clear earlier correction')
                    records[qid] = record
    for qid in sorted(set(records) | set(issues)):
        known = issues.get(qid, [])
        record = records.get(qid)
        unresolved = set(known) & HOLDS
        if record and record['reviewStatus'] == 'reviewed':
            correction = record['answerCorrection']
            if correction and correction['action'] in {'replace', 'keep-original'}:
                unresolved.discard('answer-conflict')
            if record['materialLinks']:
                unresolved -= {'missing-material', 'missing-image'}
        # An authored hold already prevents grading. Preserve its specific reason
        # and evidence instead of replacing useful analysis with a generic notice.
        if unresolved and not (record and record['answerCorrection'] and record['answerCorrection']['action'] == 'withhold'):
            q = source.question(qid)
            names = '、'.join(ISSUE_LABELS[name] for name in sorted(unresolved))
            record = {'schemaVersion': 1, 'key': {**source.scope, 'questionId': qid, 'revisionDigest': q['revisionDigest']}, 'batchId': 'derived-source-hold', 'reviewStatus': 'blocked', 'materialLinks': [], 'answerCorrection': {'action': 'withhold', 'originalOptionIds': q['answer']['optionIds'], 'correctedOptionIds': [], 'reason': '原题仍有未解决问题：' + names + '。在补齐材料或完成勘误复核前，暂停自动判分。', 'evidence': [f'已保存的 AI 批次 {issue_batches[qid]} 标记：' + names]}}
            records[qid] = record
        if record:
            record['sourceIssues'] = known
    outputs, refs, shards = {}, [], {}
    for qid, record in sorted(records.items()):
        shards.setdefault(qid[2:4], []).append(record)
    for prefix, items in sorted(shards.items()):
        require(len(items) <= 2000, 'shard count budget')
        data = encode({'schemaVersion': 1, **source.scope, 'prefix': prefix, 'records': items})
        require(len(data) <= MAX_SHARD_BYTES, 'shard byte budget')
        sha = digest(data); path = f'v1/{prefix}-{sha}.json'
        outputs[path] = data
        refs.append({'prefix': prefix, 'path': path, 'sha256': sha, 'byteLength': len(data), 'recordCount': len(items)})
    outputs['index.json'] = encode({'schemaVersion': 1, **source.scope, 'recordCount': len(records), 'shards': refs, 'sources': sources})
    require(len(outputs['index.json']) <= 256*1024, 'catalog byte budget')
    return outputs

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--repair-batch', action='append', default=[], help='Repeat oldest first')
    parser.add_argument('--ai-batch', action='append', required=True, help='Repeat oldest first')
    parser.add_argument('--check', action='store_true')
    args = parser.parse_args()
    outputs = build(ROOT, args.repair_batch, args.ai_batch)
    for name, data in outputs.items():
        path = safe(ROOT, 'supplements/repairs/reader/' + name)
        if args.check:
            require(read(path) == data, f'projection differs: {name}')
        else:
            path.parent.mkdir(parents=True, exist_ok=True); path.write_bytes(data)
    print(f'{"Verified" if args.check else "Built"} repairs: {json.loads(outputs["index.json"])["recordCount"]} questions')

if __name__ == '__main__':
    main()
