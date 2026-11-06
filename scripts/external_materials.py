"""Offline external-material validation. Image verification requires Pillow (PIL).

URLs are references only; this module never fetches them. Hashes bind bytes, not
source truth: independent review is necessary before recovery clears a hold.
"""
from datetime import date
from io import BytesIO
import ipaddress
import json
import re
from urllib.parse import urlsplit
from build_reader_supplements import require, digest, read

HASH = re.compile(r'[a-f0-9]{64}')
KEY_FIELDS = {'bankId', 'releaseId', 'manifestHash', 'questionId', 'revisionDigest'}


def plain(value, limit):
    require(isinstance(value, str) and bool(value.strip()), 'invalid external text')
    try:
        require(len(value.encode('utf-16-le')) // 2 <= limit, 'external text budget')
        value.encode('utf-8')
    except UnicodeError as exc:
        raise ValueError('invalid external Unicode') from exc
    return value


def sha(value):
    require(isinstance(value, str) and HASH.fullmatch(value), 'invalid external hash')
    return value


def day(value):
    require(isinstance(value, str) and re.fullmatch(r'\d{4}-\d{2}-\d{2}', value), 'invalid external date')
    date.fromisoformat(value)
    return value


def url(value):
    plain(value, 2048)
    require(len(value) <= 2048 and not any(c.isspace() or ord(c) < 32 or ord(c) == 127 for c in value) and '\\' not in value, 'invalid external URL')
    authority = re.match(r'^https://([^/?#]+)', value)
    require(authority and re.fullmatch(r'[a-zA-Z0-9.-]+(?::443)?', authority.group(1)), 'invalid external URL authority')
    try:
        parsed = urlsplit(value)
        host = parsed.hostname or ''
        require(parsed.scheme == 'https' and parsed.username is None and parsed.password is None and parsed.port in (None, 443), 'external URL must be HTTPS without credentials')
        require(host == host.lower() and len(host) <= 253 and '.' in host and all(re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', label) for label in host.split('.')), 'external URL public domain required')
        require(not host.endswith(('.localhost', '.local', '.internal', '.test', '.invalid', '.example', '.onion', '.home', '.lan')) and host != 'localhost', 'external URL private host')
        require(re.fullmatch(r'[a-z]{2,63}', host.split('.')[-1]), 'external URL public domain required')
        try:
            ipaddress.ip_address(host)
        except ValueError:
            pass
        else:
            raise ValueError('external URL IP address prohibited')
    except (ValueError, UnicodeError) as exc:
        raise ValueError('invalid external URL') from exc
    return value


def image_info(data, mime):
    require(0 < len(data) <= 8*1024*1024, 'external image byte budget')
    formats = {'image/png': ('PNG', data.startswith(b'\x89PNG\r\n\x1a\n')), 'image/jpeg': ('JPEG', data.startswith(b'\xff\xd8\xff')), 'image/bmp': ('BMP', data.startswith(b'BM'))}
    require(mime in formats and formats[mime][1], 'external image magic/MIME mismatch')
    try:
        from PIL import Image
        with Image.open(BytesIO(data)) as im:
            width, height = im.size
            require(im.format == formats[mime][0] and 0 < width <= 8192 and 0 < height <= 8192 and width*height <= 64000000, 'external image dimensions')
            require(getattr(im, 'n_frames', 1) == 1, 'animated image prohibited')
            im.verify()
        with Image.open(BytesIO(data)) as im:
            im.load()
    except ImportError as exc:
        raise ValueError('Pillow is required to verify external materials') from exc
    except Exception as exc:
        raise ValueError('external image decode/dimensions failed') from exc
    return width, height


def check_budget(count, size, pixels):
    require(count <= 32 and size <= 16*1024*1024 and pixels <= 64000000, 'target image budget')


def materials(rows, root, safe, count=0, size=0, pixels=0):
    require(isinstance(rows, list) and len(rows) <= 8, 'external materials budget')
    result, ids, hashes = [], set(), set()
    for row in rows:
        require(isinstance(row, dict) and {'materialId', 'kind', 'title', 'sourcePageUrl', 'sourceAssetUrl', 'checkedOn', 'identityEvidence', 'contentSha256', 'text', 'asset'} <= row.keys(), 'invalid external material')
        mid = plain(row.get('materialId'), 200)
        require(mid not in ids, 'duplicate external material ID'); ids.add(mid)
        kind = row.get('kind')
        require(kind in {'image', 'text-summary', 'text-data'}, 'invalid external material kind')
        item = {'materialId': mid, 'kind': kind, 'title': plain(row.get('title'), 300), 'sourcePageUrl': url(row.get('sourcePageUrl')), 'sourceAssetUrl': None if row.get('sourceAssetUrl') is None else url(row['sourceAssetUrl']), 'checkedOn': day(row.get('checkedOn')), 'identityEvidence': plain(row.get('identityEvidence'), 4000), 'contentSha256': sha(row.get('contentSha256')), 'text': None, 'asset': None}
        if kind == 'image':
            require(row.get('text') is None and isinstance(row.get('asset'), dict), 'invalid external image material')
            a = row['asset']; h = sha(a.get('sha256'))
            mime = a.get('mimeType'); ext = {'image/png': 'png', 'image/jpeg': 'jpg', 'image/bmp': 'bmp'}.get(mime)
            require(ext and a.get('path') == f'assets/{h}.{ext}' and item['contentSha256'] == h, 'external asset path/hash mismatch')
            require(type(a.get('byteLength')) is int and 0 < a['byteLength'] <= 8*1024*1024, 'external image byte budget')
            data = read(safe(root, 'supplements/repairs/' + a['path']), 8*1024*1024)
            require(len(data) == a['byteLength'] and digest(data) == h, 'external image hash mismatch')
            w, ht = image_info(data, mime)
            require(type(a.get('width')) is int and type(a.get('height')) is int and a['width'] == w and a['height'] == ht, 'external image declared dimensions mismatch')
            item['asset'] = {k: a[k] for k in ('path', 'sha256', 'byteLength', 'mimeType', 'width', 'height')}
            count += 1; size += len(data); pixels += w*ht
        else:
            require(row.get('asset') is None, 'text material must not have asset')
            item['text'] = plain(row.get('text'), 16000)
            require(digest(item['text'].encode('utf-8')) == item['contentSha256'], 'external text hash mismatch')
        require(item['contentSha256'] not in hashes, 'duplicate external content hash'); hashes.add(item['contentSha256'])
        check_budget(count, size, pixels)
        result.append(item)
    return result


def load_reviews(directory, meta, rows, safe):
    path = safe(directory, 'external-material-reviews.jsonl')
    expected = meta.get('externalMaterialReviewsSha256')
    if expected is None:
        require(not path.exists(), 'unbound external review file')
        return {}
    data = read(path, 16*1024*1024)
    require(digest(data) == sha(expected), 'external review file hash mismatch')
    reviews = [json.loads(line) for line in data.splitlines() if line.strip()]
    require(len(reviews) <= 2000, 'external review count budget')
    targets = {row['key']['questionId']: row for row in rows}
    result = {}
    for review in reviews:
        key = review.get('key')
        require(isinstance(key, dict) and set(key) == KEY_FIELDS, 'external review key mismatch')
        qid = key['questionId']; target = targets.get(qid)
        require(target is not None and target['key'] == key and qid not in result, 'external review key mismatch or duplicate')
        mats = target.get('externalMaterials', [])
        require(mats, 'external review without materials')
        hashes = review.get('materialHashes')
        require(isinstance(hashes, list) and len(hashes) <= 8, 'external review hashes invalid')
        hashes = [sha(h) for h in hashes]
        require(len(hashes) == len(set(hashes)) and sorted(hashes) == sorted(m['contentSha256'] for m in mats), 'stale external review hashes')
        status = review.get('reviewStatus'); coverage = review.get('coverage')
        require(status in {'reviewed', 'needs-review'} and coverage in {'sufficient', 'partial'}, 'invalid external review status')
        checks = review.get('identityChecks'); limits = review.get('limitations')
        require(isinstance(checks, list) and len(checks) <= 32 and isinstance(limits, list) and len(limits) <= 32, 'external review evidence budget')
        checks = [plain(v, 4000) for v in checks]; limits = [plain(v, 4000) for v in limits]
        reason = plain(review.get('coverageReason'), 4000)
        require(coverage != 'sufficient' or (status == 'reviewed' and len(checks) >= 3 and not limits), 'insufficient external coverage evidence')
        require(coverage != 'partial' or limits, 'partial external review requires limitations')
        result[qid] = {'key': key, 'materialHashes': hashes, 'reviewStatus': status, 'coverage': coverage, 'reviewedOn': day(review.get('reviewedOn')), 'identityChecks': checks, 'coverageReason': reason, 'limitations': limits}
    return result
