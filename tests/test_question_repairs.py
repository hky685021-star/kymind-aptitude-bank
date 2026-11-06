import copy
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'scripts'))
import build_question_repairs as b

class RepairTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(); self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name); self.bank = self.root/'original/bank-civil-aptitude'; self.release = self.bank/'releases/r1'
        self.private = Ed25519PrivateKey.generate()
        self.pub = self.private.public_key().public_bytes(Encoding.Raw, PublicFormat.Raw).hex()
        self.qid = 'q_' + 'a'*64; self.sid = 'q_' + 'b'*64
        self.q = self.question(self.qid); self.s = self.question(self.sid)
        rows = b.encode(self.q) + b.encode(self.s)
        index = {'bankId': 'bank-civil-aptitude', 'releaseId': 'r1', 'items': [{ 'questionId': q['questionId'], 'revisionDigest': q['revisionDigest'], 'shardPath': 'questions/p.jsonl', 'type': q['type'], 'practiceEligible': True, 'collectionIds': ['c1']} for q in [self.q,self.s]]}
        collection = {'bankId': 'bank-civil-aptitude', 'collectionId': 'c1', 'kind':'paper', 'orderedQuestionRefs': [{'bankId': 'bank-civil-aptitude', 'questionId': qid} for qid in [self.qid,self.sid]]}
        files = []
        for path, kind, data in [('questions/p.jsonl','question',rows),('web-index/p.json','web-index', b.encode(index)),('collections.jsonl','collection', b.encode(collection))]:
            self.put(self.release/path,data); files.append({'path':path,'kind':kind,'sha256':b.digest(data),'byteLength':len(data)})
        manifest = self.signed({'bankId':'bank-civil-aptitude','releaseId':'r1','files':files})
        self.put(self.release/'manifest.json', manifest)
        self.scope = {'bankId':'bank-civil-aptitude','releaseId':'r1','manifestHash':b.digest(manifest)}
        self.put(self.bank/'bank.json', self.signed({'bankId':'bank-civil-aptitude','currentRelease':{'releaseId':'r1','manifestHash':b.digest(manifest),'manifestPath':'releases/r1/manifest.json'}}))
        self.key = {**self.scope,'questionId':self.qid,'revisionDigest':self.q['revisionDigest']}
        self.ai([])
        self.row = {'schemaVersion':1,'key':self.key,'reviewStatus':'reviewed','materialLinks':[],'answerCorrection':{'action':'replace','originalOptionIds':['a'],'correctedOptionIds':['b'],'reason':'Verified derivation','evidence':['Calculation supports B']}}

    def put(self,path,data):
        path.parent.mkdir(parents=True,exist_ok=True); path.write_bytes(data)

    def signed(self,obj):
        obj.update(authorKeyId='test',authorPublicKeyHex=self.pub)
        obj['signature']={'algorithm':'ed25519','keyId':'test','valueHex':self.private.sign(b.encode(obj).rstrip(b'\n')).hex()}
        return b.encode(obj)

    def question(self,qid):
        q={'bankId':'bank-civil-aptitude','questionId':qid,'type':'single-choice','stem':{'format':'tiptap-portable-v1','doc':{'type':'doc','content':[{'type':'paragraph','text':'material'}]}},'options':[{'optionId':'a'},{'optionId':'b'}],'answer':{'optionIds':['a'],'grading':'objective'},'review':{'practiceEligible':True}}
        q['revisionDigest']=b.digest(b.encode(q).rstrip(b'\n')); return q

    def batch(self,kind,name,rows):
        directory=self.root/f'supplements/{kind}/batches/{name}'; data=b''.join(b.encode(r) for r in rows)
        self.put(directory/'records.jsonl',data)
        self.put(directory/'batch.json',b.encode({'bankId':self.scope['bankId'],'sourceReleaseId':'r1','sourceManifestHash':self.scope['manifestHash'],'recordCount':len(rows),'recordsSha256':b.digest(data)}))

    def ai(self,issues):
        self.batch('ai','ai',[{'key':self.key,'reviewStatus':'blocked' if issues else 'needs-review','sourceIssues':issues}])

    def build(self,rows=None,names=None):
        if rows is not None:self.batch('repairs','fix',rows)
        outputs=b.build(self.root,names if names is not None else (['fix'] if rows is not None else []),['ai'])
        return [r for path,data in outputs.items() if path!='index.json' for r in json.loads(data)['records']], outputs

    def link(self):
        return {'sourceQuestionId':self.sid,'sourceRevisionDigest':self.s['revisionDigest'],'sourceFile':'questions/p.jsonl','collectionId':'c1','evidence':'Same paper material','stemBlockIndexes':[0]}

    def test_empty_catalog(self):
        rows,out=self.build(); self.assertEqual(rows,[]); self.assertEqual(json.loads(out['index.json'])['recordCount'],0)

    def test_valid_replace_and_integrity(self):
        rows,out=self.build([self.row]); self.assertEqual(rows[0]['answerCorrection']['action'],'replace')
        for ref in json.loads(out['index.json'])['shards']:self.assertEqual(b.digest(out[ref['path']]),ref['sha256'])

    def test_each_issue_holds(self):
        for issue in b.HOLDS:
            with self.subTest(issue=issue):
                self.ai([issue]); rows,_=self.build(); self.assertEqual(rows[0]['answerCorrection']['action'],'withhold')

    def test_answer_conflict_does_not_withhold_complete_question(self):
        self.ai(['answer-conflict']); self.row['materialLinks']=[self.link()]; self.row['answerCorrection']=None
        self.assertEqual(self.build([self.row])[0][0]['reviewStatus'],'reviewed')
        self.ai(['source-unverified']); self.assertEqual(self.build([self.row])[0][0]['reviewStatus'],'reviewed')

    def test_replace_does_not_clear_missing_material(self):
        self.ai(['missing-material']); self.assertEqual(self.build([self.row])[0][0]['reviewStatus'],'blocked')
        self.row['materialLinks']=[self.link()]; self.assertEqual(self.build([self.row])[0][0]['reviewStatus'],'reviewed')

    def test_invalid_corrections(self):
        variants=[('reviewStatus','needs-review'),('originalOptionIds',[]),('originalOptionIds',['a','a']),('correctedOptionIds',['a','b']),('correctedOptionIds',['x']),('correctedOptionIds',[]),('evidence',[]),('reason','')]
        for field,value in variants:
            with self.subTest(field=field,value=value):
                row=copy.deepcopy(self.row)
                (row if field=='reviewStatus' else row['answerCorrection'])[field]=value
                with self.assertRaises(ValueError): self.build([row])

    def test_invalid_material_links(self):
        for field,value in [('sourceRevisionDigest','0'*64),('sourceFile','../questions/p.jsonl'),('sourceFile','web-index/p.json'),('collectionId','other'),('stemBlockIndexes',[0,0]),('stemBlockIndexes',[1]),('stemBlockIndexes',[True]),('stemBlockIndexes',[])]:
            with self.subTest(field=field,value=value):
                row=copy.deepcopy(self.row); link=self.link(); link[field]=value; row['materialLinks']=[link]
                with self.assertRaises(ValueError):self.build([row])

    def test_null_cannot_clear_prior_correction(self):
        self.batch('repairs','first',[self.row]); later=copy.deepcopy(self.row); later['answerCorrection']=None
        self.batch('repairs','later',[later])
        with self.assertRaises(ValueError):self.build(names=['first','later'])
        later['answerCorrection']=copy.deepcopy(self.row['answerCorrection']); later['answerCorrection'].update(action='keep-original',correctedOptionIds=[])
        self.batch('repairs','later',[later]); self.assertEqual(self.build(names=['first','later'])[0][0]['answerCorrection']['action'],'keep-original')

    def test_corrupted_source_rejected(self):
        with (self.release/'questions/p.jsonl').open('ab') as f:f.write(b' ')
        with self.assertRaises(ValueError):self.build([self.row])

    def test_stale_identity_and_duplicate_batch(self):
        self.row['key']={**self.key,'revisionDigest':'0'*64}
        with self.assertRaises(ValueError):self.build([self.row])
        with self.assertRaises(ValueError):b.build(self.root,[],['ai','ai'])

    def test_canonical_revision_checked_independently(self):
        source=b.Source(self.root)
        source.question(self.qid)
        source.cache['questions/p.jsonl'][self.qid]['answer']['optionIds']=['b']
        with self.assertRaisesRegex(ValueError,'canonical'):source.question(self.qid)

    def test_collection_membership_checked_independently(self):
        source=b.Source(self.root); source.collections['c1'].remove(self.sid)
        self.row['materialLinks']=[self.link()]
        with self.assertRaisesRegex(ValueError,'membership'):b.validate_repair(self.row,source,'fix')

    def test_withhold_never_contains_corrected_options(self):
        self.row['answerCorrection']['action']='withhold'
        with self.assertRaises(ValueError):self.build([self.row])
        self.row['answerCorrection']['correctedOptionIds']=[]
        self.row['reviewStatus']='blocked'
        self.assertEqual(self.build([self.row])[0][0]['answerCorrection']['action'],'withhold')

    def test_authored_withhold_reason_is_preserved(self):
        self.ai(['answer-conflict'])
        self.row['reviewStatus'] = 'needs-review'
        self.row['answerCorrection'].update(action='withhold', correctedOptionIds=[], reason='单选题原答案A，但原解析写AD，暂缓判分。')
        result = self.build([self.row])[0][0]
        self.assertEqual(result['answerCorrection'], self.row['answerCorrection'])
        self.assertEqual(result['reviewStatus'], 'needs-review')
        self.assertEqual(result['sourceIssues'], ['answer-conflict'])
        self.row['reviewStatus'] = 'reviewed'
        self.row['materialLinks'] = [self.link()]
        result = self.build([self.row])[0][0]
        self.assertEqual(result['answerCorrection']['action'], 'withhold')
        self.assertEqual(result['materialLinks'], self.row['materialLinks'])

    def test_material_budgets(self):
        source=b.Source(self.root)
        for blocks in [[{'type':'paragraph'}]*20001, [{'type':'text','text':'x'*200001}]]:
            q=copy.deepcopy(self.s); q['stem']['doc']['content']=blocks
            with self.assertRaises(ValueError):b.validate_material(source,q,None)
        node={'type':'paragraph'}
        for _ in range(66):node={'type':'paragraph','content':[node]}
        q=copy.deepcopy(self.s); q['stem']['doc']['content']=[node]
        with self.assertRaises(ValueError):b.validate_material(source,q,None)
        q=copy.deepcopy(self.s); q['review']['status']='quarantined'
        with self.assertRaises(ValueError):b.validate_material(source,q,None)
        q['review']['status']='reviewed';q['review']['practiceEligible']=False
        with self.assertRaises(ValueError):b.validate_material(source,q,None)

    def test_material_images(self):
        source=b.Source(self.root); q=copy.deepcopy(self.s)
        q['stem']['doc']['content']=[{'type':'questionImage','attrs':{'occurrenceId':'image1'}}]
        data=b'fake-test-image'; sha=b.digest(data)
        media={'mediaId':'media_'+sha,'path':'assets/test.png','mimeType':'image/png','byteLength':len(data),'sha256':sha}
        source.manifest['media']=[media]
        source.files[media['path']]={**media,'kind':'media'}
        self.put(source.release/media['path'],data)
        occurrence={'occurrenceId':'image1','zone':'stem','status':'ready','mediaId':media['mediaId']}
        q['mediaOccurrences']=[occurrence]
        self.assertEqual(b.validate_material(source,q,None),(1,len(data)))
        occurrence['status']='missing'
        with self.assertRaises(ValueError):b.validate_material(source,q,None)
        occurrence['status']='ready';q['mediaOccurrences'].append(dict(occurrence))
        with self.assertRaises(ValueError):b.validate_material(source,q,None)
        q['mediaOccurrences'].pop();media['mimeType']='image/svg+xml'
        with self.assertRaises(ValueError):b.validate_material(source,q,None)
        media['mimeType']='image/png';media['byteLength']=16*1024*1024+1
        with self.assertRaises(ValueError):b.validate_material(source,q,None)
        media['byteLength']=len(data);self.put(source.release/media['path'],b'corrupt')
        with self.assertRaises(ValueError):b.validate_material(source,q,None)

    def test_cumulative_target_image_budget(self):
        self.row['materialLinks']=[self.link(),{**self.link(),'stemBlockIndexes':None}]
        source=b.Source(self.root)
        for result in [(17,100),(1,9*1024*1024)]:
            with patch.object(b,'validate_material',return_value=result):
                with self.assertRaisesRegex(ValueError,'target image budget'):b.validate_repair(self.row,source,'fix')

    def test_runtime_record_alignment(self):
        for modify in ['self-link','duplicate','empty-evidence','unchanged','nonobjective']:
            row=copy.deepcopy(self.row)
            if modify=='self-link':
                link=self.link();link['sourceQuestionId']=self.qid;row['materialLinks']=[link]
            elif modify=='duplicate':row['materialLinks']=[self.link(),self.link()]
            elif modify=='empty-evidence':row['answerCorrection'].update(action='withhold',correctedOptionIds=[],evidence=[])
            elif modify=='unchanged':row['answerCorrection']['correctedOptionIds']=['a']
            else:
                source=b.Source(self.root); source.question(self.qid)['answer']['grading']='subjective'
                with self.assertRaises(ValueError):b.validate_repair(row,source,'fix')
                continue
            with self.assertRaises(ValueError):self.build([row])

    def test_symlink_parent_rejected(self):
        dest=self.root/'escape'; dest.symlink_to(self.bank,target_is_directory=True)
        with self.assertRaises(ValueError):b.safe(self.root,'escape/bank.json')

if __name__=='__main__': unittest.main()
