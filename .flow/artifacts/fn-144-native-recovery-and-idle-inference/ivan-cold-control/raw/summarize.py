import pathlib,json
root=pathlib.Path('/private/tmp/fn1445-capacity-packed-021990ed.kAAORH')
print('STDOUT',(root/'evidence/capacity-first.stdout').read_text())
print('STDERR',(root/'evidence/capacity-first.stderr').read_text()[-4000:])
rows=[]
for file in sorted((root/'protocol').glob('session-*/native-*/*.json')):
 if file.name=='bootstrap.json':continue
 row=json.loads(file.read_text());c=row['capture']
 rows.append({'file':str(file.relative_to(root)),'identity':row['identity'],'request':{k:v for k,v in row['request'].items() if k not in ['prompt','documents','texts','text']},'complete':row['complete'],'lifecycle':row.get('lifecycle'),'models':c['models'],'backends':c['backends'],'errors':c['errors'],'modelInputs':[{'role':i['role'],'modelId':i['modelId'],'inputBytes':len(json.dumps(i['input']))}for i in c['modelInputs']],'contextEvents':[e for e in c.get('contextEvents',[]) if e['method']!='tokenize'],'tokenizeEvents':sum(e['method']=='tokenize'for e in c.get('contextEvents',[]))})
print(json.dumps(rows,indent=2))
(root/'evidence/native-stage-summary.json').write_text(json.dumps(rows,indent=2)+'\n')
