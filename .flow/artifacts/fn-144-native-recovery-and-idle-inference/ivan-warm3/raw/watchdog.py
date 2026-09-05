"""Distinct physical-capacity policy: warning allowed for <=30 sampled seconds.
Same 120s wall limit / 6144 MiB owned group cap. Critical4 stops immediately.
Read-only sysctl; kills only the newly-created test process group.
"""
import ctypes,hashlib,json,os,signal,subprocess,sys,time
from pathlib import Path
KEY=b'kern.memorystatus_vm_pressure_level'
LIB=ctypes.CDLL(None,use_errno=True)
def pressure():
    value=ctypes.c_int();size=ctypes.c_size_t(ctypes.sizeof(value))
    if LIB.sysctlbyname(KEY,ctypes.byref(value),ctypes.byref(size),None,0):
        raise OSError(ctypes.get_errno(),'pressure unavailable')
    return value.value
prefix=Path(sys.argv[1]);command=sys.argv[2:]
assert command and not prefix.with_suffix('.receipt.json').exists()
preflight=pressure()
if preflight!=1:raise RuntimeError('Normal-pressure preflight required: '+str(preflight))
policy={'stratum':'capacity-warning30-v1','pressureKey':KEY.decode(),'normal':1,'warning':2,'critical':4,'warningBudgetSeconds':30,'wallSeconds':120,'ownedGroupRssMiB':6144,'pollSeconds':0.2,'xnuSourceCommit':'f6217f891ac0bb64f3d375211650a4c1ff8ca1ea','warningAccounting':'sample-hold monotonic seconds; raw transition samples retained; resolution <=250ms'}
start=time.monotonic();previous=start;previous_level=preflight;warning=0.;samples=[];reason=None
with prefix.with_suffix('.stdout').open('x') as out,prefix.with_suffix('.stderr').open('x') as err:
    child=subprocess.Popen(command,stdout=out,stderr=err,start_new_session=True)
    try:
        while True:
            tick=time.monotonic();level=pressure();dt=tick-previous
            if previous_level==2:warning+=dt
            previous=tick;previous_level=level
            rows=subprocess.run(['ps','-axo','pid=,pgid=,rss='],capture_output=True,text=True,timeout=.2,check=True).stdout.splitlines()
            owned=[list(map(int,row.split())) for row in rows if len(row.split())==3 and int(row.split()[1])==child.pid]
            rss=sum(row[2] for row in owned);elapsed=tick-start
            samples.append({'elapsedSeconds':elapsed,'sampleIntervalSeconds':dt,'pressure':level,'cumulativeWarningSeconds':warning,'rssKiB':rss,'ownedPids':[row[0]for row in owned]})
            if level==4:reason='critical_pressure'
            elif level not in (1,2):reason='unexpected_pressure'
            elif warning>=30:reason='warning_budget'
            elif rss>6144*1024:reason='rss_limit'
            elif elapsed>=120:reason='timeout'
            elif dt>.25:reason='poll_interval_exceeded'
            if reason or child.poll() is not None:break
            delay=min(.2,120-elapsed,30-warning if level==2 else .2)-(time.monotonic()-tick)
            if delay>0:time.sleep(delay)
    except BaseException as error:
        reason='governor_error:'+repr(error)
    finally:
        if child.poll() is None:
            os.killpg(child.pid,signal.SIGTERM)
            try:child.wait(timeout=5)
            except subprocess.TimeoutExpired:os.killpg(child.pid,signal.SIGKILL)
        code=child.wait()
end=time.monotonic()
receipt={'policy':policy,'governorSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'command':command,'pid':child.pid,'exit':code,'stopReason':reason,'wallSeconds':end-start,'cumulativeWarningSeconds':warning,'samples':samples,'finalPressure':pressure(),'physicalQualityComplete':code==0 and reason is None}
prefix.with_suffix('.receipt.json').write_text(json.dumps(receipt,indent=2)+'\n')
print(json.dumps({k:v for k,v in receipt.items() if k!='samples'}))
sys.exit(0 if receipt['physicalQualityComplete'] else 1)
