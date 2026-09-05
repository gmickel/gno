import pathlib,json,hashlib,tarfile,shutil,sqlite3
r=pathlib.Path('/private/tmp/fn1445-ask-packed-9244d715.QBZRbQ');sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
assert sha(r/'candidate.tgz')=='f42dfdddd6296e527f3c4bf01d21bb8a685a33996edcfd1c7624e60fe13320bd'
with tarfile.open(r/'candidate.tgz') as t:t.extractall(r,filter='data')
s=r/'package';product={str(p.relative_to(s)):sha(p)for p in s.rglob('*')if p.is_file()}
with tarfile.open(r/'helpers.tar') as t:t.extractall(s,filter='data')
assert all(sha(s/p)==h for p,h in product.items())
(r/'product-files.json').write_text(json.dumps(product,indent=2))
(r/'helper-files.json').write_text(json.dumps({str(p.relative_to(s)):sha(p)for p in s.rglob('*')if p.is_file()and str(p.relative_to(s)) not in product},indent=2))
(s/'node_modules').symlink_to('/Users/gordon/.bun/install/global/node_modules',target_is_directory=True)
init=json.loads((r/'original-init.json').read_text());m=json.loads((r/'original-manifest.json').read_text());shutil.copytree('/private/tmp/fn143-orchid-metal-01/corpus',r/'corpus')
for n in ['data','cache','protocol','evidence']:(r/n).mkdir(mode=0o700)
with sqlite3.connect('file:'+init['dbPath']+'?mode=ro',uri=True)as src,sqlite3.connect(r/'data/index-default.sqlite')as dst:src.backup(dst)
for c in init['config']['collections']:c['path']=str(r/'corpus'/c['name'])
init['dbPath']=str(r/'data/index-default.sqlite');init['cacheDir']=str(r/'cache')
m['role']='candidate';m['identity']['commit']='d0604b0d7b0c888653390618ab498187bf71b397';m['identity']['indexId']='ivan-packed-original-orchid-ask';m['identity']['indexSha256']=sha(init['dbPath'])
request={'manifest':m,'caseId':m['cases'][0]['caseId'],**m['cases'][0]['configuration']['request']}
setup={'config':init['config'],'init':init,'manifest':m,'sourceRoot':str(s),'root':str(r),'request':request,'provenance':{'packageSha256':sha(r/'candidate.tgz'),'helperSha256':sha(r/'helpers.tar'),'helperCommit':'9244d715','originalInitSha256':sha(r/'original-init.json'),'originalManifestSha256':sha(r/'original-manifest.json'),'changedConfigFields':['collection paths relocated to identical copied synthetic bytes'],'governorSha256':sha(r/'watchdog.py')}}
(r/'setup.json').write_text(json.dumps(setup,indent=2));(r/'manifest.json').write_text(json.dumps(m,indent=2));(r/'config.json').write_text(json.dumps(init['config'],indent=2))
print(json.dumps({'root':str(r),'configSha':sha(r/'config.json'),'corpusFiles':len(list((r/'corpus').rglob('*.md'))),'request':request['options']}))
