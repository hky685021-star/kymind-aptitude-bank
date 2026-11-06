import copy
from io import BytesIO
import json
import sys
from pathlib import Path
import unittest
from unittest.mock import patch
from PIL import Image
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import build_question_repairs as b
import external_materials as e
import test_question_repairs as fixture


class ExternalTests(fixture.RepairTests):
    def material(self, text='原始数据\n  末尾空格  '):
        return {'materialId': 'external-1', 'kind': 'text-data', 'title': '统计材料', 'sourcePageUrl': 'https://www.stats.gov.cn/page', 'sourceAssetUrl': None, 'checkedOn': '2026-11-06', 'identityEvidence': '同题组、题干与选项逐项比对', 'contentSha256': b.digest(text.encode()), 'text': text, 'asset': None}

    def review(self, materials=None):
        return {'key': self.key, 'materialHashes': [m['contentSha256'] for m in (materials or self.row['externalMaterials'])], 'reviewStatus': 'reviewed', 'coverage': 'sufficient', 'reviewedOn': '2026-11-06', 'identityChecks': ['题组标题一致', '题干逐字一致', 'A/B选项相符'], 'coverageReason': '所需数据与单位完整', 'limitations': []}

    def setup_external(self):
        self.row['externalMaterials'] = [self.material()]
        self.row['answerCorrection'] = None
        self.ai(['missing-material'])

    def reviewed_build(self, review):
        self.batch('repairs', 'fix', [self.row])
        if review is not None:
            directory = self.root/'supplements/repairs/batches/fix'
            data = b.encode(review)
            self.put(directory/'external-material-reviews.jsonl', data)
            meta = json.loads((directory/'batch.json').read_bytes())
            meta['externalMaterialReviewsSha256'] = b.digest(data)
            self.put(directory/'batch.json', b.encode(meta))
        return self.build(names=['fix'])[0][0]

    def image_material(self, fmt='PNG'):
        buf = BytesIO(); Image.new('RGB', (4, 3), 'red').save(buf, format=fmt)
        data = buf.getvalue(); h = b.digest(data)
        ext, mime = {'PNG': ('png', 'image/png'), 'JPEG': ('jpg', 'image/jpeg'), 'BMP': ('bmp', 'image/bmp')}[fmt]
        asset = {'path': f'assets/{h}.{ext}', 'sha256': h, 'byteLength': len(data), 'mimeType': mime, 'width': 4, 'height': 3}
        self.put(self.root/'supplements/repairs'/asset['path'], data)
        return {**self.material(), 'kind': 'image', 'text': None, 'asset': asset, 'contentSha256': h}

    def test_external_exact_text_and_sufficient_review(self):
        self.setup_external(); self.row['complete'] = True
        out = self.reviewed_build(self.review())
        self.assertEqual(out['externalMaterials'], self.row['externalMaterials'])
        self.assertEqual(out['externalReview'], self.review())
        self.assertEqual(out['sourceIssues'], ['missing-material'])
        self.assertIsNone(out['answerCorrection'])
        self.assertEqual(out['reviewStatus'], 'reviewed')
        self.assertNotIn('complete', out)
        self.row['externalMaterials'][0]['text'] += '\n'
        with self.assertRaisesRegex(ValueError, 'text hash'): self.reviewed_build(self.review())

    def test_sufficient_independent_of_record_status(self):
        self.setup_external(); self.row['reviewStatus'] = 'blocked'
        out = self.reviewed_build(self.review())
        self.assertIsNone(out['answerCorrection'])
        self.assertEqual(out['externalReview']['coverage'], 'sufficient')
        self.assertEqual(out['sourceIssues'], ['missing-material'])

    def test_partial_preserves_answer_annotation_evidence(self):
        self.setup_external()
        correction = {'action': 'replace', 'originalOptionIds': ['a'], 'correctedOptionIds': ['b'], 'reason': '有争议的计算', 'evidence': ['独立计算证据']}
        self.row['answerCorrection'] = correction
        r = self.review(); r.update(coverage='partial', limitations=['缺图'])
        out = self.reviewed_build(r)
        self.assertEqual(out['answerCorrection'], correction)
        self.assertEqual(out['reviewStatus'], 'reviewed')
        self.assertEqual(out['externalReview']['coverage'], 'partial')
        self.row['answerCorrection'].update(action='keep-original', correctedOptionIds=[])
        out = self.reviewed_build(r)
        self.assertEqual(out['reviewStatus'], 'reviewed')
        self.assertEqual(out['answerCorrection']['action'], 'keep-original')

    def test_missing_review_cannot_unlock_even_cleared_ai(self):
        self.setup_external(); self.ai([]); self.row['complete'] = True
        self.row['externalReview'] = self.review()  # Inline claims are ignored.
        out = self.reviewed_build(None)
        self.assertEqual(out['answerCorrection']['action'], 'withhold')
        self.assertIsNone(out['externalReview'])
        self.assertEqual(out['externalMaterials'], self.row['externalMaterials'])

    def test_partial_review_preserves_content_and_authored_hold(self):
        self.setup_external()
        review = self.review(); review.update(coverage='partial', limitations=['仍缺图例'])
        out = self.reviewed_build(review)
        self.assertEqual(out['answerCorrection']['action'], 'withhold')
        self.assertEqual(out['externalReview'], review)
        self.assertEqual(out['externalMaterials'], self.row['externalMaterials'])
        self.row['answerCorrection'] = {'action': 'withhold', 'originalOptionIds': ['a'], 'correctedOptionIds': [], 'reason': '原始分析：仍缺图例', 'evidence': ['保留详细证据']}
        self.assertEqual(self.reviewed_build(review)['answerCorrection'], self.row['answerCorrection'])

    def test_unreviewed_cannot_unlock(self):
        self.setup_external(); r = self.review(); r.update(reviewStatus='needs-review', coverage='partial', limitations=['待复核'])
        self.assertEqual(self.reviewed_build(r)['answerCorrection']['action'], 'withhold')

    def test_external_review_binding(self):
        self.setup_external()
        variants = []
        for field, value in [('key', {**self.key, 'revisionDigest': '0'*64}), ('materialHashes', ['0'*64]), ('materialHashes', []), ('materialHashes', [self.material()['contentSha256']]*2), ('reviewStatus', 'needs-review'), ('identityChecks', ['只有一项']), ('coverageReason', ''), ('limitations', ['尚缺数据']), ('reviewedOn', '2026-02-30')]:
            r = self.review(); r[field] = value; variants.append(r)
        for r in variants:
            with self.subTest(review=r), self.assertRaises(ValueError): self.reviewed_build(r)
        self.reviewed_build(self.review())
        path = self.root/'supplements/repairs/batches/fix/external-material-reviews.jsonl'
        path.write_bytes(path.read_bytes()+b' ')
        with self.assertRaisesRegex(ValueError, 'file hash'): self.build(names=['fix'])
        # An unbound review file is an error, never silently treated as absent.
        self.batch('repairs', 'fix', [self.row])
        with self.assertRaisesRegex(ValueError, 'unbound'): self.build(names=['fix'])

    def test_stale_review_after_material_change(self):
        self.setup_external(); old = self.review()
        self.row['externalMaterials'] = [self.material('不同数据')]
        with self.assertRaisesRegex(ValueError, 'stale'): self.reviewed_build(old)

    def test_images_valid_and_invalid(self):
        for fmt in ['PNG', 'JPEG', 'BMP']:
            self.setup_external(); self.row['externalMaterials'] = [self.image_material(fmt)]
            self.assertEqual(self.reviewed_build(self.review())['externalMaterials'], self.row['externalMaterials'])
        base = self.image_material()
        for field, value in [('path', '../outside.png'), ('path', '/tmp/a.png'), ('mimeType', 'image/svg+xml'), ('mimeType', 'image/jpeg'), ('width', 5), ('height', True), ('byteLength', 8*1024*1024+1), ('sha256', '0'*64)]:
            m = copy.deepcopy(base); m['asset'][field] = value
            with self.subTest(field=field), self.assertRaises(ValueError): e.materials([m], self.root, b.safe)
        self.put(self.root/'supplements/repairs'/base['asset']['path'], b'not PNG')
        with self.assertRaises(ValueError): e.materials([base], self.root, b.safe)

    def test_mime_magic_and_decoded_dimensions(self):
        with self.assertRaises(ValueError): e.image_info(b'BMnot-valid', 'image/png')
        with self.assertRaises(ValueError): e.image_info(b'\x89PNG\r\n\x1a\nnot-valid', 'image/png')
        buf = BytesIO(); Image.new('1', (8193, 1)).save(buf, format='PNG')
        with self.assertRaises(ValueError): e.image_info(buf.getvalue(), 'image/png')

    def test_combined_budgets_and_string_limits(self):
        m = self.image_material()
        for count, size, pixels in [(32, 0, 0), (0, 16*1024*1024, 0), (0, 0, 64000000)]:
            with self.assertRaisesRegex(ValueError, 'target image budget'): e.materials([m], self.root, b.safe, count, size, pixels)
        for field, value in [('title', 'x'*301), ('identityEvidence', 'x'*4001), ('text', '😀'*8001), ('checkedOn', '2026-1-01')]:
            m = self.material(); m[field] = value
            with self.assertRaises(ValueError): e.materials([m], self.root, b.safe)
        with self.assertRaises(ValueError): e.materials([self.material()]*9, self.root, b.safe)
        self.setup_external(); self.row['materialLinks'] = [self.link()]
        with patch.object(b, 'validate_material', return_value=(32, 100)):
            self.row['externalMaterials'] = [self.image_material()]
            with self.assertRaises(ValueError): self.reviewed_build(self.review())

    def test_reference_urls(self):
        for value in ['HTTPS://stats.gov.cn', 'https://stats.gov.cn:0443', 'https:stats.gov.cn', 'https:///stats.gov.cn', 'https://@stats.gov.cn', 'https://%73tats.gov.cn', 'https://例子.com', 'javascript:alert(1)', 'http://stats.gov.cn', 'https://localhost/x', 'https://foo.local/x', 'https://127.0.0.1/x', 'https://[::1]/', 'https://2130706433/', 'https://user:pass@stats.gov.cn/', 'https://stats.gov.cn:444/', 'https://stats.gov.cn\\@localhost/x', 'https://stats.gov.cn/\nfoo', '//stats.gov.cn', 'https://stats.gov.cn/'+'x'*2048]:
            with self.subTest(url=value), self.assertRaises(ValueError): e.url(value)
        self.assertEqual(e.url('https://stats.gov.cn:443/a?x=1#ref'), 'https://stats.gov.cn:443/a?x=1#ref')

    def test_sufficient_does_not_override_original_answer(self):
        self.setup_external(); self.row['answerCorrection'] = {'action': 'keep-original', 'originalOptionIds': ['a'], 'correctedOptionIds': [], 'reason': '完整题目按原答案', 'evidence': ['核对原始答案']}
        out = self.reviewed_build(self.review())
        self.assertEqual(out['answerCorrection']['originalOptionIds'], ['a'])
        self.assertEqual(out['answerCorrection']['correctedOptionIds'], [])
        self.assertEqual(out['answerCorrection']['action'], 'keep-original')


if __name__ == '__main__': unittest.main()
