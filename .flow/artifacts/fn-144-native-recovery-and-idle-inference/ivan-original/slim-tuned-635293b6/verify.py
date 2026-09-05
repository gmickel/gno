import pathlib,tarfile,hashlib,json
r=pathlib.Path(__file__).resolve().parent;count=0;bad=[]
with tarfile.open(r/'source.tar') as archive:
 for member in archive.getmembers():
  if member.isfile() and member.name.startswith('src/'):
   count+=1
   if hashlib.sha256(archive.extractfile(member).read()).digest()!=hashlib.sha256((r/'source'/member.name).read_bytes()).digest():bad.append(member.name)
 receipt={'commit':archive.pax_headers['comment'],'verifiedSourceFiles':count,'mismatches':bad,'indexSha256AfterRun':hashlib.sha256((r/'data/index-default.sqlite').read_bytes()).hexdigest()}
(r/'evidence/source-verification.json').write_text(json.dumps(receipt,indent=2))
assert not bad
