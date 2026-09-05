import pathlib,hashlib,json,sqlite3,tarfile,shutil
root=pathlib.Path('/private/tmp/fn1445-capacity-packed-021990ed.kAAORH')
archive=root/'candidate.tgz'
sha=lambda p:hashlib.sha256(pathlib.Path(p).read_bytes()).hexdigest()
assert sha(archive)=='f42dfdddd6296e527f3c4bf01d21bb8a685a33996edcfd1c7624e60fe13320bd'
with tarfile.open(archive) as t:t.extractall(root,filter='data')
source=root/'package'
product_hashes={str(f.relative_to(source)):sha(f) for f in source.rglob('*') if f.is_file()}
with tarfile.open(root/'helpers.tar') as t:t.extractall(source,filter='data')
assert all(sha(source/p)==h for p,h in product_hashes.items())
(root/'product-files.json').write_text(json.dumps(product_hashes,indent=2)+'\n')
(root/'helper-files.json').write_text(json.dumps({str(f.relative_to(source)):sha(f) for f in source.rglob('*') if f.is_file() and str(f.relative_to(source)) not in product_hashes},indent=2)+'\n')
(source/'node_modules').symlink_to('/Users/gordon/.bun/install/global/node_modules',target_is_directory=True)
old=pathlib.Path('/tmp/fn1445-ivan-slim-635293b6')
config=json.loads((old/'config/index.yml').read_text())
shutil.copytree('/tmp/gno-native-baseline-20260905.VQtXt5/index-trace-vault',root/'corpus')
for col in config['collections']:col['path']=str(root/'corpus'/col['name'])
for name in ['data','cache','protocol','evidence']:(root/name).mkdir(mode=0o700)
with sqlite3.connect('file:'+str(old/'data/index-default.sqlite')+'?mode=ro',uri=True) as src,sqlite3.connect(root/'data/index-default.sqlite') as dst:src.backup(dst)
(root/'config.json').write_text(json.dumps(config,indent=2)+'\n')
modelsha={'embed':'06507c7b42688469c4e7298b0a1e16deff06caf291cf0a5b278c308249c3e439','rerank':'22c9979ce4fbcdc5acdc310c6641c32797eff1aa980b8f7a2db8a8ea23429a48','expand':'3b20c99404c2c1d66ad695489bf91cf5b5d3369e8055d5587fc60507ceac3338','gen':'b139949c5bd74937ad8ed8c8cf3d9ffb1e99c866c823204dc42c0d91fa181897'}
models=[{'role':{'embed':'embedding','rerank':'reranking','expand':'generation','gen':'generation'}[role],'id':config['models']['presets'][0][role],'sha256':h,'tokenizerSha256':h}for role,h in modelsha.items()]
rows=[{'path':str(f.relative_to(root/'corpus')),'sha256':sha(f)}for f in sorted((root/'corpus').rglob('*'))if f.is_file()]
(root/'fixtures.json').write_text(json.dumps(rows,sort_keys=True,separators=(',',':')))
fixture=sha(root/'fixtures.json')
query='what retry budget did we decide and why'
manifest={'schemaVersion':'gno-acceptance-v1','role':'candidate','identity':{'commit':'d0604b0d7b0c888653390618ab498187bf71b397','indexId':'ivan-original143-capacity-warning30-packed','indexSha256':sha(root/'data/index-default.sqlite'),'bunVersion':'1.3.14','nativeDependencies':{'node-llama-cpp':'3.19.1'},'platform':'darwin','architecture':'arm64'},'fixtureVersion':'fn1445-original143-corrected-slim-child-v1','fixtures':[{'path':'fixtures.json','sha256':fixture}],'models':models,'cases':[{'caseId':'original143-sdk-hybrid','fixtureSha256':fixture,'surface':'sdk','preset':'slim-tuned','configuration':{'query':query,'operation':'hybrid','options':{'limit':5},'warmModelTtl':300000}}],'intendedDeltas':[]}
(root/'manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(root/'setup.json').write_text(json.dumps({'config':config,'manifest':manifest,'sourceRoot':str(source),'root':str(root),'request':{'manifest':manifest,'caseId':'original143-sdk-hybrid','query':query,'operation':'hybrid','options':{'limit':5},'expectedBackend':'metal'},'provenance':{'sourceArchiveSha256':sha(archive),'originalConfigSha256':sha(old/'config/index.yml'),'relocatedConfigSha256':sha(root/'config.json'),'corpusFiles':len(rows),'changedConfigFields':['collection paths relocated to identical copied synthetic bytes'],'physicalNativeRun':False,'resourcePolicyStratum':'capacity-warning30-v1','helperCommit':'021990ed','helperArchiveSha256':sha(root/'helpers.tar'),'governorSha256':sha(root/'watchdog.py')}},indent=2)+'\n')
print(json.dumps({'root':str(root),'source':str(source),'files':len(rows),'configSha':sha(root/'config.json')}))
