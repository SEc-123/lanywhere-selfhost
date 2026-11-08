#!/usr/bin/env python3
"""Deterministic, names-only Switch 1 catalog from pinned MIT TitleDB metadata.

Default: entirely offline from sanitized source snapshots. --fetch downloads
only the pinned regional metadata, verifies Git blob hashes, and retains a
strict field allowlist. No images, keys, descriptions, patches or DLC persist.
"""
import argparse
import codecs
import collections
import concurrent.futures
import gzip
import hashlib
import io
import json
from pathlib import Path
import re
import tempfile
import unicodedata
import urllib.request

ROOT=Path(__file__).resolve().parent
CHUNK=1024*1024
APP=re.compile(r'^0100[0-9A-F]{12}$')
HAN=re.compile(r'[\u3400-\u9fff\U00020000-\U0003134f]')

def encoded(value):
    return (json.dumps(value,ensure_ascii=False,sort_keys=True,separators=(',',':'))+'\n').encode('utf-8')

def write(path,data):
    path.parent.mkdir(parents=True,exist_ok=True)
    temporary=path.with_suffix(path.suffix+'.tmp')
    temporary.write_bytes(data)
    temporary.replace(path)

def name_text(value):
    if not isinstance(value,str):return ''
    value=unicodedata.normalize('NFC',value)
    value=''.join(c for c in value if unicodedata.category(c) not in ('Cc','Cf'))
    value=' '.join(value.split()).strip()
    return value if 0<len(value.encode('utf-8'))<=512 else ''

def base_appid(value):
    if not isinstance(value,str):return None
    value=value.upper()
    if not APP.fullmatch(value):return None
    number=int(value,16)
    return value if number>=0x0100000000010000 and not number&0x1fff else None

class Pairs:
    """Incremental outer JSON object parser; memory bounded per source record."""
    def __init__(self,response,size):
        self.response=response;self.buffer='';self.pos=0;self.eof=False;self.size=0
        self.decoder=codecs.getincrementaldecoder('utf-8')();self.json=json.JSONDecoder()
        self.sha256=hashlib.sha256();self.git=hashlib.sha1(('blob '+str(size)+'\0').encode())
    def more(self):
        if self.eof:return False
        if self.pos:self.buffer=self.buffer[self.pos:];self.pos=0
        data=self.response.read(CHUNK);self.size+=len(data);self.sha256.update(data);self.git.update(data)
        self.eof=not data;self.buffer+=self.decoder.decode(data,final=self.eof)
        if len(self.buffer)>8*CHUNK:raise ValueError('Oversized source record')
        return bool(data)
    def space(self):
        while True:
            while self.pos<len(self.buffer) and self.buffer[self.pos].isspace():self.pos+=1
            if self.pos<len(self.buffer) or not self.more():return
    def token(self,char):
        self.space()
        if self.pos>=len(self.buffer) or self.buffer[self.pos]!=char:raise ValueError('Invalid JSON boundary')
        self.pos+=1
    def value(self):
        self.space()
        while True:
            try:value,end=self.json.raw_decode(self.buffer,self.pos);self.pos=end;return value
            except json.JSONDecodeError:
                if not self.more():raise
    def __iter__(self):
        self.token('{');self.space()
        if self.buffer[self.pos:self.pos+1]=='}':self.pos+=1
        else:
            while True:
                key=self.value();self.token(':');value=self.value()
                if not isinstance(key,str) or not isinstance(value,dict):raise ValueError('Unexpected regional metadata shape')
                yield key,value
                self.space()
                if self.buffer[self.pos:self.pos+1]=='}':self.pos+=1;break
                self.token(',')
        self.space()
        if self.pos<len(self.buffer):raise ValueError('Trailing JSON content')

def sanitize(key,row,counters):
    counters['raw_records']+=1
    nsuid=str(row.get('nsuId') or key)
    if nsuid.startswith('7005'):counters['excluded_dlc_products']+=1;return None
    if nsuid.startswith('7007'):counters['excluded_bundles']+=1;return None
    if not nsuid.startswith(('7001','7003')):counters['excluded_other_product_types']+=1;return None
    raw=row.get('id');appid=base_appid(raw)
    if not appid:
        if isinstance(raw,str) and raw.upper().startswith('0400'):reason='excluded_switch2_ids'
        elif isinstance(raw,str) and re.fullmatch('[0-9a-fA-F]{16}',raw) and int(raw,16)&0x1fff:reason='excluded_update_dlc_or_subprogram_ids'
        else:reason='excluded_missing_invalid_or_system_ids'
        counters[reason]+=1;return None
    name=name_text(row.get('name'))
    if not name:counters['excluded_empty_or_oversized_names']+=1;return None
    counters['accepted_rows']+=1
    demo=bool(row.get('isDemo')) or nsuid.startswith('7003')
    if demo:counters['demo_rows']+=1
    return {'appid':appid,'name':name,'nsuid':nsuid,'demo':demo}

def fetch_source(lock,item,cache):
    url=f"https://raw.githubusercontent.com/blawar/titledb/{lock['commit']}/{item['name']}"
    request=urllib.request.Request(url,headers={'User-Agent':'LANywhere-names-only-catalog/1','Accept-Encoding':'identity'})
    counters=collections.Counter();rows=[]
    with urllib.request.urlopen(request,timeout=30) as response:
        pairs=Pairs(response,item['bytes'])
        for key,row in pairs:
            clean=sanitize(key,row,counters)
            if clean:rows.append(clean)
    if pairs.size!=item['bytes'] or pairs.git.hexdigest()!=item['git_blob_sha1']:
        raise ValueError('Pinned source integrity mismatch: '+item['name'])
    rows.sort(key=lambda r:(r['appid'],r['demo'],int(r['nsuid']),r['name']))
    snapshot={'schema':1,'repository':lock['repository'],'commit':lock['commit'],'file':item['name'],
        'raw_bytes':pairs.size,'raw_sha256':pairs.sha256.hexdigest(),'git_blob_sha1':pairs.git.hexdigest(),
        'counters':dict(sorted(counters.items())),'records':rows}
    raw=encoded(snapshot);out=io.BytesIO()
    with gzip.GzipFile(fileobj=out,mode='wb',mtime=0,filename='') as zipped:zipped.write(raw)
    write(cache/(item['name']+'.gz'),out.getvalue())
    print(item['name']+': '+str(len(rows))+' sanitized rows',flush=True)
    return item['name'],hashlib.sha256(raw).hexdigest()

def generate(lock,cache):
    if hashlib.sha256((ROOT/'LICENSE.titledb').read_bytes()).hexdigest()!=lock['license_sha256']:
        raise ValueError('Pinned MIT license changed')
    candidates=collections.defaultdict(lambda:collections.defaultdict(list));inputs={};source_stats={}
    for item in lock['files']:
        raw=gzip.decompress((cache/(item['name']+'.gz')).read_bytes())
        if hashlib.sha256(raw).hexdigest()!=item['sanitized_sha256']:raise ValueError('Sanitized snapshot changed: '+item['name'])
        source=json.loads(raw)
        assert source['commit']==lock['commit'] and source['file']==item['name'] and source['git_blob_sha1']==item['git_blob_sha1']
        inputs[item['name']]={k:source[k] for k in ('raw_bytes','raw_sha256','git_blob_sha1','counters')}
        inputs[item['name']]['sanitized_sha256']=item['sanitized_sha256']
        apps=set()
        for row in source['records']:
            assert set(row)=={'appid','name','nsuid','demo'} and base_appid(row['appid'])==row['appid']
            apps.add(row['appid'])
            if item['language']=='zh' and not HAN.search(row['name']):continue
            candidates[row['appid']][item['language']].append((row['demo'],item['priority'],int(row['nsuid']),row['name'],item['locale'],item['name']))
        source_stats[item['name']]={'eligible_unique_appids':len(apps),**source['counters']}
    records=[];provenance={};conflicts=[]
    for appid,langs in sorted(candidates.items()):
        record={'appid':appid,'en':'','zh':'','zh_locale':''};details={}
        for lang,values in sorted(langs.items()):
            values.sort();chosen=values[0];record[lang]=chosen[3]
            if lang=='zh':record['zh_locale']=chosen[4]
            details[lang]={'file':chosen[5],'nsuid':str(chosen[2])}
            unique=sorted(set(v[3] for v in values))
            if len(unique)>1:conflicts.append({'appid':appid,'language':lang,'chosen':chosen[3],'alternatives':unique})
        if record['en'] or record['zh']:records.append(record);provenance[appid]=details
    overrides=json.loads((ROOT/'curated-labels.json').read_text())
    index={r['appid']:r for r in records}
    for row in overrides['records']:
        if row['appid'] not in index:raise ValueError('Curated label has no pinned base AppID: '+row['appid'])
        for lang in ('en','zh'):
            if lang in row:
                index[row['appid']][lang]=name_text(row[lang]);provenance[row['appid']][lang]={'curated_evidence':row['evidence']}
        if 'zh' in row:index[row['appid']]['zh_locale']=row['zh_locale']
    catalog={'schema':1,'source_commit':lock['commit'],'scope':'Switch 1 base application names; display metadata only','records':records}
    observations=json.loads((ROOT/'lcid-observations.json').read_text());maps={}
    for row in observations['observations']:
        for lcid in sorted(set(row['lcids'])):
            if lcid in ('0000000000000000','FFFFFFFFFFFFFFFF'):raise ValueError('Unresolved LCID cannot be mapped')
            m=maps.setdefault(lcid,{'lcid':lcid,'appids':[],'evidence':[],'ambiguous':False,'exhaustive':False,'launch_authority':False})
            m['appids'].append(row['appid']);m['evidence'].append(row['evidence'])
            m['ambiguous']|=lcid in row.get('known_ambiguous_lcids',[])
    for lcid,m in maps.items():
        m['appids']=sorted(set(m['appids']));m['evidence']=sorted(set(m['evidence']));m['ambiguous']|=len(m['appids'])>1
        m['unknown_additional_candidates_possible']=True
        m['raw_appid_catalog_candidates']=[lcid] if lcid in index and lcid not in m['appids'] else []
    mappings={'schema':1,'scope':'Observed NACP relations only; partial sample, never exhaustive','mappings':[maps[k] for k in sorted(maps)]}
    coverage={'schema':1,'base_appids':len(records),'en_names':sum(bool(r['en']) for r in records),'zh_names':sum(bool(r['zh']) for r in records),
        'both_languages':sum(bool(r['en'] and r['zh']) for r in records),'zh_hans':sum(r['zh_locale'].startswith('zh-Hans') for r in records),
        'zh_hant_hk':sum(r['zh_locale']=='zh-Hant-HK' for r in records),'localized_name_conflict_groups':len(conflicts),
        'explicit_lcid_relations':len(maps),'known_ambiguous_lcids':sum(m['ambiguous'] for m in maps.values()),'sources':source_stats,
        'coverage_denominator':'Eligible exact AppIDs in the pinned input files, not every Switch game worldwide',
        'sword':{'appid':'0100ABF008968000','catalog_record':index.get('0100ABF008968000'),'explicit_lcid_proof':False,
            'resolution':'raw LCID equal to catalog AppID may be displayed as a catalog candidate only'}}
    provenance_file={'schema':1,'repository':lock['repository'],'commit':lock['commit'],'license':'MIT','license_file':'LICENSE.titledb',
        'license_sha256':lock['license_sha256'],'license_url':lock['license_url'],
        'generator_sha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'input_files':inputs,'record_sources':provenance,
        'curated_labels_sha256':hashlib.sha256((ROOT/'curated-labels.json').read_bytes()).hexdigest(),
        'lcid_observations_sha256':hashlib.sha256((ROOT/'lcid-observations.json').read_bytes()).hexdigest(),
        'locale_policy':'CN source names preferred; HK source is labeled zh-Hant-HK by source region, not machine-converted. Roman-only HK names are not counted as Chinese translations.',
        'namespace_policy':'AppID is not LCID. Catalog candidates are display-only and never prove installation, local launch safety or game interoperability.'}
    for name,value in [('catalog.json',catalog),('lcid-mappings.json',mappings),('coverage.json',coverage),('provenance.json',provenance_file),('name-conflicts.json',{'schema':1,'conflicts':conflicts})]:
        write(ROOT/name,encoded(value))
    print(json.dumps({k:coverage[k] for k in ('base_appids','en_names','zh_names','both_languages','explicit_lcid_relations','known_ambiguous_lcids')},ensure_ascii=False),flush=True)

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--fetch',action='store_true');parser.add_argument('--cache-dir',type=Path);args=parser.parse_args()
    lock=json.loads((ROOT/'source-lock.json').read_text())
    cache=args.cache_dir or Path(tempfile.gettempdir())/('lanywhere-title-catalog-'+lock['commit'][:12])
    if args.fetch:
        with concurrent.futures.ThreadPoolExecutor(max_workers=2) as pool:
            hashes=dict(pool.map(lambda item:fetch_source(lock,item,cache),lock['files']))
        for item in lock['files']:
            if item.get('sanitized_sha256') not in (None,hashes[item['name']]):raise ValueError('Pinned sanitized output changed')
            item['sanitized_sha256']=hashes[item['name']]
        write(ROOT/'source-lock.json',encoded(lock))
    generate(lock,cache)

if __name__=='__main__':main()
