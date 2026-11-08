#!/usr/bin/env python3
"""Names-only filters, namespace separation and deterministic offline generation."""
import collections
import contextlib
import gzip
import hashlib
import importlib.util
import io
import json
from pathlib import Path
import tempfile
import unittest

HERE=Path(__file__).resolve().parent
spec=importlib.util.spec_from_file_location('catalog_generator',HERE/'generator.py')
g=importlib.util.module_from_spec(spec);spec.loader.exec_module(g)
SWORD='0100ABF008968000';DYING='01008C8012920000';VIOLET='01008F6008C5E000';SCARLET='0100A3D008C5C000'

class CatalogTests(unittest.TestCase):
    def test_base_application_namespace(self):
        self.assertEqual(g.base_appid(SWORD.lower()),SWORD)
        for value in ('0000000000000000','FFFFFFFFFFFFFFFF','0400ABF008968000','0100ABF008968800','0100ABF008969001','0100ABF008968001','0100000000001000','0100ZZZZZZZZ0000',None):
            self.assertIsNone(g.base_appid(value),value)

    def test_only_name_identity_fields_survive(self):
        row={'id':SWORD,'name':'Pokémon Sword','nsuId':70010000000001,'key':'SECRET','rightsId':'SECRET',
             'iconUrl':'https://example.invalid/image','screenshots':['SECRET'],'description':'SECRET'}
        clean=g.sanitize('70010000000001',row,collections.Counter())
        self.assertEqual(set(clean),{'appid','name','nsuid','demo'})
        self.assertNotIn('SECRET',json.dumps(clean));self.assertNotIn('http',json.dumps(clean))

    def test_dlc_bundle_updates_and_switch2_never_become_base_titles(self):
        for nsuid,appid in [('70050000000001',SWORD),('70070000000001',SWORD),('70010000000001','0100ABF008968800'),('70010000000001','0400ABF008968000')]:
            self.assertIsNone(g.sanitize(nsuid,{'id':appid,'name':'Unsafe alias','nsuId':nsuid},collections.Counter()))

    def test_streaming_utf8_boundaries_and_source_digest(self):
        raw=json.dumps({'70010000000001':{'id':SWORD,'name':'宝可梦 剑'},'70010000000002':{'id':VIOLET,'name':'Pokémon Violet'}},ensure_ascii=False).encode()
        class Tiny(io.BytesIO):
            def read(self,n=-1):return super().read(min(n,5))
        reader=g.Pairs(Tiny(raw),len(raw));rows=list(reader)
        self.assertEqual(rows[0][1]['name'],'宝可梦 剑')
        self.assertEqual(reader.size,len(raw));self.assertEqual(reader.sha256.hexdigest(),hashlib.sha256(raw).hexdigest())
        self.assertEqual(reader.git.hexdigest(),hashlib.sha1(b'blob '+str(len(raw)).encode()+b'\0'+raw).hexdigest())

    def test_offline_generation_is_deterministic_and_ambiguity_survives(self):
        with tempfile.TemporaryDirectory(prefix='title-catalog-unit-') as temporary:
            root=Path(temporary);cache=root/'cache';cache.mkdir();previous=g.ROOT;g.ROOT=root
            try:
                for file in ('LICENSE.titledb','curated-labels.json','lcid-observations.json'):(root/file).write_bytes((HERE/file).read_bytes())
                lock={'repository':'https://github.com/blawar/titledb','commit':'1'*40,'license_url':'https://example.invalid/LICENSE',
                      'license_sha256':hashlib.sha256((root/'LICENSE.titledb').read_bytes()).hexdigest(),'files':[]}
                for filename,language,locale,priority,names in [
                    ('US.en.json','en','en-US',0,[(SWORD,'Pokémon Sword'),(DYING,'Dying Light'),(VIOLET,'Pokémon Violet'),(SCARLET,'Pokémon Scarlet')]),
                    ('GB.en.json','en','en-GB',1,[(SWORD,'Sword regional alternative')]),
                    ('HK.zh.json','zh','zh-Hant-HK',1,[(SWORD,'寶可夢 劍'),(SCARLET,'寶可夢 朱')])]:
                    source={'schema':1,'commit':lock['commit'],'file':filename,'git_blob_sha1':'a'*40,'raw_sha256':'b'*64,'raw_bytes':123,'counters':{'accepted_rows':len(names)},
                            'records':[{'appid':appid,'name':name,'nsuid':str(70010000000001+i),'demo':False} for i,(appid,name) in enumerate(names)]}
                    raw=g.encoded(source);(cache/(filename+'.gz')).write_bytes(gzip.compress(raw,mtime=0))
                    lock['files'].append({'name':filename,'language':language,'locale':locale,'priority':priority,'git_blob_sha1':'a'*40,'sanitized_sha256':hashlib.sha256(raw).hexdigest()})
                with contextlib.redirect_stdout(io.StringIO()):g.generate(lock,cache)
                files=['catalog.json','lcid-mappings.json','provenance.json','coverage.json','name-conflicts.json']
                before={p:(root/p).read_bytes() for p in files}
                with contextlib.redirect_stdout(io.StringIO()):g.generate(lock,cache)
                self.assertEqual(before,{p:(root/p).read_bytes() for p in files})
                rows={r['appid']:r for r in json.loads(before['catalog.json'])['records']}
                self.assertEqual(rows[SWORD]['en'],'Pokémon Sword');self.assertEqual(rows[SWORD]['zh'],'宝可梦 剑')
                self.assertEqual(rows[SCARLET]['zh_locale'],'zh-Hant-HK')
                mappings={r['lcid']:r for r in json.loads(before['lcid-mappings.json'])['mappings']}
                self.assertNotIn(SWORD,mappings,'TitleDB AppID must never become an invented NACP relation')
                self.assertTrue(mappings[SCARLET]['ambiguous']);self.assertFalse(mappings[SCARLET]['exhaustive'])
                self.assertEqual(mappings[SCARLET]['appids'],[VIOLET]);self.assertEqual(mappings[SCARLET]['raw_appid_catalog_candidates'],[SCARLET])
                self.assertTrue(all(not m['launch_authority'] for m in mappings.values()))
                # The offline path checks sanitized snapshot integrity before parsing.
                (cache/'US.en.json.gz').write_bytes(gzip.compress(b'{}'))
                with self.assertRaises(ValueError):g.generate(lock,cache)
            finally:g.ROOT=previous

    def test_real_catalog_contract_and_public_privacy(self):
        records=json.loads((HERE/'catalog.json').read_text())['records'];ids=[r['appid'] for r in records]
        self.assertEqual(ids,sorted(set(ids)));self.assertGreater(len(ids),20000)
        for row in records:
            self.assertEqual(set(row),{'appid','en','zh','zh_locale'});self.assertEqual(g.base_appid(row['appid']),row['appid'])
        sword=next(r for r in records if r['appid']==SWORD);self.assertEqual(sword['zh'],'宝可梦 剑');self.assertIn('Sword',sword['en'])
        for name in ('curated-labels.json','lcid-observations.json','provenance.json'):
            text=(HERE/name).read_text()
            for forbidden in ('/Volumes/','/Users/','cache_payload_sha256','source_report_sha256','iconUrl','rightsId','screenshots'):
                self.assertNotIn(forbidden,text)
        obs=json.loads((HERE/'lcid-observations.json').read_text())
        self.assertEqual(obs['evidence']['local_nacp_20261107']['public_records_sha256'],hashlib.sha256(g.encoded(obs['observations'])).hexdigest())

if __name__=='__main__':unittest.main()
