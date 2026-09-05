import pathlib,json,hashlib
r=pathlib.Path(__file__).parent;raw=r/'raw';rows=json.loads((raw/'results.json').read_text());runs=[]
for name in ['default','expiry','fresh-control']:
 d=json.loads((raw/(name+'.process.json')).read_text());children={};samples=[]
 for s in d['samples']:
  owned=[]
  for p in s['processes']:
   if len(p)>4 and '/native-worker/entry.ts ' in p[4]:
    cfg=json.loads(p[4].split('/native-worker/entry.ts ',1)[1]);child=children.setdefault(p[0],{'pid':int(p[0]),'parentPid':int(p[1]),'generation':cfg['generation'],'firstObservedSeconds':s['seconds'],'bootstrap':cfg});child['lastObservedSeconds']=s['seconds']
   owned.append({'pid':int(p[0]),'rssBytes':int(p[2])*1024})
  samples.append({'seconds':s['seconds'],'rssBytes':sum(x['rssBytes'] for x in owned),'processes':owned,'pressure':s['gpu']})
 polls=[{'seconds':p['seconds'],'stage':p['stage'],'models':p['response']['resident']['models']} for p in d['statusPolls']]
 runs.append({'name':name,'parentPid':d['parentPid'],'exit':d['exit'],'stopReasons':d['stopReasons'],'nativeChildren':list(children.values()),'metadataPollCount':len(polls),'metadataPolls':polls,'peakOwnedRssBytes':max(s['rssBytes'] for s in samples),'resourceSamples':samples})
evidence={'commit':'23ba2c258e2d6c27b03aa7504a7d28f88d1ae2cf','task':'fn144.4 actual Ivan REST expiry recovery','result':'passed scoped resident recovery','futureChildCapture':'incomplete; no actual child model argument/backend transcript collected','nativeBackend':'metal explicitly requested, not independently captured through child-native hook','historicalBaseline':'270c3a74f4f7a3aeb8a60462b4c8e1b4adf45462 initial20-result response exact equality','counts':{'requests':len(rows),'allHTTP200':all(x['status']==200 for x in rows),'all20Results':all(len(x['body']['results'])==20 for x in rows),'metadataPolls':sum(x['metadataPollCount'] for x in runs)},'stages':[{'stage':x['stage'],'ttl':x['ttl'],'parentPid':x['parentPid'],'status':x['status'],'milliseconds':x['ms'],'count':len(x['body']['results']),'meta':x['body']['meta']} for x in rows],'runs':runs,'pins':json.loads((raw/'pins.json').read_text()),'comparison':'fn143-response-comparison.json (posthoc full-array equality; native capture explicitly incomplete)','remoteRoot':'/tmp/fn1444-ivan-23ba2c25','gpuReleased':True}
(r/'evidence.json').write_text(json.dumps(evidence,indent=2))
print(json.dumps({'counts':evidence['counts'],'runs':[{'name':x['name'],'parent':x['parentPid'],'children':[(c['pid'],c['generation']) for c in x['nativeChildren']],'peakRSS':x['peakOwnedRssBytes']} for x in runs]}))
