import pathlib,tarfile,hashlib,json
r=pathlib.Path(__file__).parent;bad=[];count=0
with tarfile.open(r/'candidate.tar') as archive:
 for member in archive.getmembers():
  if member.isfile() and member.name.startswith('src/'):
   count+=1
   if hashlib.sha256(archive.extractfile(member).read()).digest()!=hashlib.sha256((r/'source'/member.name).read_bytes()).digest():bad.append(member.name)
 (r/'evidence/source-verification.json').write_text(json.dumps({'commit':archive.pax_headers['comment'],'verifiedSourceFiles':count,'mismatches':bad},indent=2))
assert not bad
