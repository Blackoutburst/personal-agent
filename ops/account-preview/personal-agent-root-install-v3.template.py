"""Owner-run privileged installation of the approved account-only preview.

The worker prepares this file but never runs its privileged entry point.
Private pilot UUIDs are entered only in the operator's terminal, never in Board.
"""
import fcntl, getpass, hashlib, json, os, pwd, stat, subprocess, sys, time, uuid
import urllib.error, urllib.request
from pathlib import Path

STAGE = Path('/home/ubuntu/personal-agent/staging/account-preview-v3-20261101')
MANIFEST_SHA = 'MANIFEST_SHA_PLACEHOLDER'
PARSER_SHA = 'PARSER_SHA_PLACEHOLDER'
DIAGNOSTIC_SHA = 'DIAGNOSTIC_SHA_PLACEHOLDER'
UNIT = Path('/etc/systemd/system/personal-agent-account.service')
INCLUDE = Path('/etc/nginx/personal-agent-preview.locations')
TARGET = Path('/etc/nginx/sites-available/bakushin')
TARGET_SECTION = Path('/etc/nginx/sites-enabled/bakushin')
PUBLIC_ANCHOR = '/etc/nginx/blackoutburst-platform/public.conf'
RECEIPT_DIR = Path('/var/lib/personal-agent-account-staging')
RECEIPT = RECEIPT_DIR/'install-20261101-v3.json'
PRIOR_STAGE = Path('/home/ubuntu/personal-agent/staging/account-preview-v2-20261101')
PRIOR_RECEIPT = RECEIPT_DIR/'install-20261101-v2.json'
PRIOR_BACKUP = RECEIPT_DIR/'root-vhost.before.conf'
PRIOR_MANIFEST_SHA = '8206f42fab966eb3f0386159223004a32b113f2dd0a6de24bc0e8e24ab9b2c58'
PRIOR_INSTALLER_SHA = 'cf9c38f28f54a5f5bc563b9af274dcf20d4a9490907d95a95d4f5dc0c2aabda2'
OLD_RECEIPT = RECEIPT_DIR/'install-20261101.json'
OLD_BACKUP = RECEIPT_DIR/'public.before.conf'
OLD_INCLUDE = Path('/etc/nginx/blackoutburst-platform/personal-agent-preview.conf')
BACKUP = RECEIPT_DIR/'root-vhost-v3.before.conf'
NODE = '/opt/blackoutburst-platform-runtime/node-v24.22.1'
SERVICE = 'personal-agent-account.service'
PILOT = Path('/home/ubuntu/personal-agent-config/pilot.json')
DATA = Path('/home/ubuntu/personal-agent-data')
SYSTEMCTL = '/usr/bin/systemctl'
NGINX = '/usr/sbin/nginx'
digest = lambda data: hashlib.sha256(data).hexdigest()
QUALIFIER_NAMESPACE = None

class Refused(Exception):
    def __init__(self, reason, diagnostic=None):
        super().__init__(reason)
        self.diagnostic=diagnostic

def require(condition, reason):
    if not condition:
        raise Refused(reason)

def read_file(path, expected=None, owner=None, maximum=4*1024*1024):
    info = path.lstat()
    require(stat.S_ISREG(info.st_mode) and not path.is_symlink() and info.st_nlink == 1, 'UNSAFE_FILE')
    require(info.st_size <= maximum, 'FILE_LIMIT')
    if owner is not None:
        require(info.st_uid == owner and not (info.st_mode & 0o022), 'UNSAFE_FILE_OWNER')
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW)
    with os.fdopen(fd, 'rb') as handle:
        opened = os.fstat(handle.fileno())
        require((opened.st_dev,opened.st_ino)==(info.st_dev,info.st_ino), 'FILE_CHANGED')
        data = handle.read(maximum+1)
    require(len(data) <= maximum, 'FILE_LIMIT')
    require(expected is None or digest(data)==expected, 'FILE_HASH_DRIFT')
    return data

def check_directory(path, owner, private=False):
    info = path.lstat()
    require(stat.S_ISDIR(info.st_mode) and not path.is_symlink() and info.st_uid==owner, 'UNSAFE_DIRECTORY')
    require(not (info.st_mode & 0o022), 'WRITABLE_DIRECTORY')
    if private:
        require(stat.S_IMODE(info.st_mode)==0o700, 'DIRECTORY_NOT_PRIVATE')

def check_ancestors(path):
    for parent in reversed(path.parents):
        info = parent.lstat()
        require(stat.S_ISDIR(info.st_mode) and not parent.is_symlink(), 'SYMLINK_ANCESTOR')
        require(info.st_uid in (0,pwd.getpwnam('ubuntu').pw_uid) and not (info.st_mode & 0o022), 'UNTRUSTED_ANCESTOR')

def run(args, accepted=(0,), timeout=30):
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout,
        env={'PATH':'/usr/sbin:/usr/bin:/sbin:/bin','LANG':'C.UTF-8'})
    require(result.returncode in accepted, 'COMMAND_FAILED:'+Path(args[0]).name)
    require(len(result.stdout.encode()) <= 4*1024*1024 and len(result.stderr.encode()) <= 128*1024, 'COMMAND_OUTPUT_LIMIT')
    return result

def write_new(path, data, mode=0o600, owner=0, group=0):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
    with os.fdopen(fd, 'wb') as out:
        os.fchmod(out.fileno(),mode)
        os.fchown(out.fileno(),owner,group)
        out.write(data); out.flush(); os.fsync(out.fileno())
    parent=os.open(path.parent,os.O_DIRECTORY)
    try: os.fsync(parent)
    finally: os.close(parent)

def replace_file(path, expected, data, mode=0o600, owner=0, group=0):
    read_file(path,expected,owner)
    temporary = path.with_name('.personal-agent-install-'+str(os.getpid()))
    write_new(temporary,data,mode,owner,group)
    try:
        read_file(path,expected,owner)
        os.replace(temporary,path)
        fd=os.open(path.parent,os.O_DIRECTORY); os.fsync(fd); os.close(fd)
    finally:
        if temporary.exists(): temporary.unlink()

def remove_owned(path, expected):
    read_file(path,expected,0)
    path.unlink()
    parent=os.open(path.parent,os.O_DIRECTORY)
    try: os.fsync(parent)
    finally: os.close(parent)

def save_receipt(receipt):
    data=(json.dumps(receipt,sort_keys=True,indent=2)+'\n').encode()
    if RECEIPT.exists():
        old=read_file(RECEIPT,owner=0)
        replace_file(RECEIPT,digest(old),data)
    else:
        write_new(RECEIPT,data)

def public_receipt(receipt):
    return {key:value for key,value in receipt.items() if not key.startswith('_')}

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self,*args,**kwargs): return None

def probe(url, method='GET', headers=None, body=None, timeout=5):
    opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect)
    try:
        response=opener.open(urllib.request.Request(url,data=body,headers=headers or {},method=method),timeout=timeout)
    except urllib.error.HTTPError as error:
        response=error
    with response:
        data=response.read(65537)
        require(len(data)<=65536,'PROBE_BODY_LIMIT')
        return response.status,dict((k.lower(),v) for k,v in response.headers.items()),data

def port_listeners(port=4318):
    records=[]
    for family in ('tcp','tcp6'):
        for line in Path('/proc/net/'+family).read_text().splitlines()[1:]:
            fields=line.split()
            address,number=fields[1].rsplit(':',1)
            if fields[3]=='0A' and int(number,16)==port:
                records.append((family,address,fields[9]))
    return records

def verify_listener(pid, port=4318):
    listeners=port_listeners(port)
    require(len(listeners)==1 and listeners[0][:2]==('tcp','0100007F'),'LISTENER_BOUNDARY_FAILED')
    owned=set()
    for descriptor in Path('/proc/'+str(pid)+'/fd').iterdir():
        try: value=os.readlink(descriptor)
        except FileNotFoundError: continue
        if value.startswith('socket:[') and value.endswith(']'): owned.add(value[8:-1])
    require(listeners[0][2] in owned,'LISTENER_PID_MISMATCH')

def show_properties(unit, names):
    args=[SYSTEMCTL,'show',unit]
    for name in names: args.extend(['-p',name])
    return dict(line.split('=',1) for line in run(args).stdout.splitlines() if '=' in line)

def one_command(value):
    import re
    found=re.findall(r'\{ path=(.*?) ; argv\[\]=(.*?) ; ignore_errors=(yes|no) ;',value)
    require(len(found)==1 and value.count('{')==1 and value.count('}')==1,'MERGED_COMMAND_UNSUPPORTED')
    path,arguments,ignored=found[0]
    require(ignored=='no','MERGED_COMMAND_IGNORES_FAILURE')
    return path,arguments

def validate_unit_properties(props, release):
    require(props.get('LoadState')=='loaded' and props.get('FragmentPath')==str(UNIT),'MERGED_UNIT_SOURCE_CHANGED')
    require(not props.get('DropInPaths',''),'UNREVIEWED_UNIT_DROPINS')
    require(props.get('User')=='ubuntu' and props.get('Group')=='ubuntu' and props.get('WorkingDirectory')==str(release),'MERGED_UNIT_IDENTITY_CHANGED')
    require(one_command(props.get('ExecStart',''))==(NODE,NODE+' '+str(release/'server.mjs')),'MERGED_START_COMMAND_CHANGED')
    for field in ('ExecCondition','ExecStartPre','ExecStartPost','ExecReload','ExecStop','ExecStopPost','EnvironmentFiles','PassEnvironment','RootDirectory','OnFailure','OnSuccess'):
        require(not props.get(field,''),'UNREVIEWED_UNIT_HOOK_OR_CONTEXT')
    for field in ('FailureAction','SuccessAction','StartLimitAction'):
        require(props.get(field,'none') in ('','none'),'UNREVIEWED_UNIT_ACTION')
    for field in ('BindsTo','Requisite','PartOf','Upholds','PropagatesStopTo','StopPropagatedFrom','PropagatesReloadTo','ReloadPropagatedFrom'):
        require(not props.get(field,''),'UNREVIEWED_UNIT_RELATIONSHIP')
    for field,allowed in [('Requires',{'sysinit.target','system.slice','systemd-journald.socket'}),('Wants',set())]:
        require(all(value in allowed or value.endswith('.mount') for value in props.get(field,'').split()),'UNREVIEWED_UNIT_DEPENDENCY')
    require(set(props.get('Conflicts','').split())<={'shutdown.target'},'UNREVIEWED_UNIT_CONFLICT')
    require(set(props.get('Before','').split())<={'shutdown.target'},'UNREVIEWED_UNIT_ORDERING')

def verify_effective_unit(release):
    fields=['LoadState','FragmentPath','DropInPaths','User','Group','WorkingDirectory','ExecStart',
        'ExecCondition','ExecStartPre','ExecStartPost','ExecReload','ExecStop','ExecStopPost','EnvironmentFiles','PassEnvironment','RootDirectory',
        'OnFailure','OnSuccess','FailureAction','SuccessAction','StartLimitAction','BindsTo','Requisite','PartOf','Upholds',
        'PropagatesStopTo','StopPropagatedFrom','PropagatesReloadTo','ReloadPropagatedFrom','Requires','Wants','Conflicts','Before']
    validate_unit_properties(show_properties(SERVICE,fields),release)
    paths=run(['/usr/bin/systemd-analyze','unit-paths']).stdout.splitlines()
    for name in paths:
        require(Path(name).is_absolute(),'UNIT_LOAD_PATH_UNSUPPORTED')
        for suffix in ('.wants','.requires','.upholds'):
            directory=Path(name)/(SERVICE+suffix)
            if directory.exists() or directory.is_symlink():
                require(directory.is_dir() and not any(directory.iterdir()),'UNREVIEWED_UNIT_DEPENDENCY_DIRECTORY')
    require(run([SYSTEMCTL,'is-enabled',SERVICE],accepted=(0,1)).stdout.strip()=='disabled','UNEXPECTED_BOOT_ENABLEMENT')

def verify_nginx_service():
    props=show_properties('nginx.service',['MainPID','ExecStart','ExecReload','DropInPaths','ActiveState'])
    require(props.get('ActiveState')=='active' and not props.get('DropInPaths',''),'NGINX_SERVICE_CONTEXT_CHANGED')
    require(one_command(props.get('ExecStart',''))==(NGINX,NGINX+' -g daemon on; master_process on;'),'NGINX_NONDEFAULT_START')
    require(one_command(props.get('ExecReload',''))==(NGINX,NGINX+' -g daemon on; master_process on; -s reload'),'NGINX_NONDEFAULT_RELOAD')
    pid=int(props.get('MainPID','0')); require(pid>1,'NGINX_PID_INVALID')
    require(Path('/proc/'+str(pid)+'/exe').resolve()==Path(NGINX) and Path('/proc/'+str(pid)).stat().st_uid==0,'NGINX_PROCESS_IDENTITY_CHANGED')
    validate_nginx_master_command(read_file(Path('/proc/'+str(pid)+'/cmdline'),maximum=4096))

def validate_nginx_master_command(data):
    require(isinstance(data,bytes) and len(data)<=4096,'NGINX_MASTER_COMMAND_UNSUPPORTED')
    arguments=data.rstrip(b'\0').split(b'\0')
    expected=NGINX.encode()
    supported=([expected,b'-g',b'daemon on; master_process on;'],
        [b'nginx: master process '+expected+b' -g daemon on; master_process on;'])
    require(arguments in supported,'NGINX_MASTER_NONDEFAULT_CONFIGURATION')

def verify_target_binding():
    require(TARGET_SECTION.is_symlink() and TARGET_SECTION.lstat().st_uid==0 and TARGET_SECTION.resolve()==TARGET,'TARGET_LOADED_ALIAS_CHANGED')
    return nginx_snapshot([str(TARGET_SECTION)])

def verify_service(release):
    props=dict(line.split('=',1) for line in run([SYSTEMCTL,'show',SERVICE,'-p','ActiveState','-p','SubState','-p','MainPID','-p','User','-p','FragmentPath']).stdout.splitlines())
    require(props.get('ActiveState')=='active' and props.get('SubState')=='running' and props.get('User')=='ubuntu', 'SERVICE_NOT_READY')
    require(props.get('FragmentPath')==str(UNIT),'UNIT_PATH_CHANGED')
    pid=int(props.get('MainPID','0')); require(pid>1,'SERVICE_PID_INVALID')
    require(Path('/proc/'+str(pid)+'/exe').resolve()==Path(NODE),'EXECUTABLE_CHANGED')
    require(Path('/proc/'+str(pid)+'/cwd').resolve()==release,'WORKING_DIRECTORY_CHANGED')
    require(Path('/proc/'+str(pid)).stat().st_uid==pwd.getpwnam('ubuntu').pw_uid,'PROCESS_OWNER_CHANGED')
    command=Path('/proc/'+str(pid)+'/cmdline').read_bytes().rstrip(b'\0').split(b'\0')
    require(command==[NODE.encode(),str(release/'server.mjs').encode()],'PROCESS_COMMAND_CHANGED')
    verify_listener(pid)
    enabled=run([SYSTEMCTL,'is-enabled',SERVICE],accepted=(0,1)).stdout.strip()
    require(enabled=='disabled','UNEXPECTED_BOOT_ENABLEMENT')
    status,headers,data=probe('http://127.0.0.1:4318/api/status')
    require(status==200 and headers.get('cache-control')=='no-store','LOOPBACK_STATUS_FAILED')
    parsed=json.loads(data)
    require(parsed['service']['mode']=='account' and parsed['adapters']['provider']['state']=='unavailable' and parsed['adapters']['runtime']['state']=='unavailable','ADAPTER_BOUNDARY_FAILED')
    return pid

def route_diagnostic(leg, status=None, headers=None, body=b''):
    # Closed fields only: response text, headers, cookies and identities never escape.
    allowed_codes={'ORIGIN_REJECTED','HOST_REJECTED','METHOD_NOT_ALLOWED','UNSUPPORTED_MEDIA_TYPE',
        'BAD_REQUEST','BODY_TOO_LARGE','REQUEST_TIMEOUT','AUTHENTICATION_REQUIRED','INVITATION_REQUIRED',
        'ACCOUNT_VALIDATION_UNAVAILABLE','COMPANION_STORE_UNAVAILABLE','COMPANION_STATE_INVALID',
        'FOUNDATIONS_UNAVAILABLE','NOT_FOUND','INTERNAL_ERROR'}
    code=None
    try:
        candidate=json.loads(body)['error']['code']
        if type(candidate) is str and candidate in allowed_codes: code=candidate
    except (ValueError,TypeError,KeyError): pass
    return {'leg':leg,'status':status if type(status) is int and 100<=status<=599 else None,
        'no_store':isinstance(headers,dict) and headers.get('cache-control')=='no-store','error_code':code}

def verify_routes():
    checks={}
    public='https://blackoutburst.com/personal-agent-preview'
    def observed(leg, url, method='GET', headers=None, body=None, timeout=5):
        try: return probe(url,method,headers,body,timeout=timeout)
        except Exception:
            raise Refused('ROUTE_PROBE_FAILED',route_diagnostic(leg)) from None
    def checked(condition, reason, leg, result):
        if not condition: raise Refused(reason,route_diagnostic(leg,*result))
    for label,base in [('local','http://127.0.0.1:4318'),('public',public)]:
        if label=='public':
            deadline=time.monotonic()+15
            last=(None,{},b'')
            while True:
                remaining=deadline-time.monotonic()
                checked(remaining>0,'PUBLIC_READINESS_TIMEOUT','public_readiness',last)
                last=observed('public_readiness',public+'/api/status',timeout=min(5,remaining))
                status,cache,data=last
                if status==404:
                    remaining=deadline-time.monotonic()
                    checked(remaining>0,'PUBLIC_READINESS_TIMEOUT','public_readiness',last)
                    time.sleep(min(0.25,remaining)); continue
                ready=False
                try:
                    parsed=json.loads(data)
                    ready=(parsed['service']['mode']=='account' and
                        parsed['adapters']['provider']['state']=='unavailable' and
                        parsed['adapters']['runtime']['state']=='unavailable')
                except (ValueError,TypeError,KeyError): pass
                checked(status==200 and cache.get('cache-control')=='no-store' and ready,
                    'PUBLIC_READINESS_FAILED','public_readiness',last)
                break
        headers={'Origin':'https://blackoutburst.com','Content-Type':'application/json'}
        result=observed(label+'_anonymous',base+'/api/session','POST',headers,b'{}')
        status,cache,_=result
        checked(status==401 and cache.get('cache-control')=='no-store','ANONYMOUS_DENIAL_FAILED',label+'_anonymous',result)
        checks[label+'_anonymous']=status
        headers['Cookie']='__Secure-blackout_session='+'Z'*43
        result=observed(label+'_invalid_cookie',base+'/api/session','POST',headers,b'{}')
        status,cache,_=result
        checked(status==401 and cache.get('cache-control')=='no-store','INVALID_COOKIE_DENIAL_FAILED',label+'_invalid_cookie',result)
    result=observed('slash_redirect',public)
    status,headers,_=result
    checked(status==302 and headers.get('location') in ('/personal-agent-preview/','https://blackoutburst.com/personal-agent-preview/'),
        'SLASH_REDIRECT_FAILED','slash_redirect',result)
    for asset,leg in [('/','page'),('/app.js','script'),('/styles.css','styles'),('/api/status','status')]:
        result=observed('public_'+leg,public+asset)
        checked(result[0]==200,'TARGET_ASSET_FAILED','public_'+leg,result)
    result=observed('account_health','http://127.0.0.1:9011/healthz')
    status,_,data=result
    healthy=False
    try: healthy=json.loads(data).get('ok') is True
    except (ValueError,AttributeError,TypeError): pass
    checked(status==200 and healthy,'ACCOUNT_HEALTH_FAILED','account_health',result)
    checks['account_health']=status
    result=observed('public_internal','https://blackoutburst.com/internal/account/session')
    checked(result[0]==404,'INTERNAL_ROUTE_EXPOSED','public_internal',result); checks['public_internal']=result[0]
    return checks

def nginx_snapshot(paths):
    snapshot={}
    public_info=TARGET.stat()
    for name in paths:
        path=Path(name)
        require(path.is_absolute(),'NGINX_SOURCE_PATH_INVALID')
        for parent in path.parents:
            info=parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and not parent.is_symlink() and info.st_uid==0 and not (info.st_mode & 0o022),'NGINX_SOURCE_PARENT_UNTRUSTED')
        named=path.lstat()
        require(named.st_uid==0,'NGINX_SOURCE_LINK_UNTRUSTED')
        resolved=path.resolve(strict=True)
        for parent in resolved.parents:
            info=parent.lstat()
            require(stat.S_ISDIR(info.st_mode) and info.st_uid==0 and not (info.st_mode & 0o022),'NGINX_RESOLVED_PARENT_UNTRUSTED')
        data=read_file(resolved,owner=0)
        info=resolved.stat()
        if (info.st_dev,info.st_ino)==(public_info.st_dev,public_info.st_ino):
            require(name==str(TARGET_SECTION),'NGINX_SHARED_TARGET_ALIAS')
        snapshot[name]={'resolved':str(resolved),'device':info.st_dev,'inode':info.st_ino,'sha256':digest(data)}
    return snapshot

def insert_preview_anchor(data, qualification):
    require(b'\r' not in data,'TARGET_LINE_ENDINGS_UNSUPPORTED')
    offset=qualification.get('anchor_byte_offset')
    require(type(offset) is int and 0 <= offset < len(data),'ANCHOR_OFFSET_INVALID')
    require(offset==0 or data[offset-1:offset]==b'\n','ANCHOR_NOT_AT_LINE_START')
    end=data.find(b'\n',offset)
    end=len(data) if end<0 else end+1
    line=data[offset:end]
    import re
    expression=rb'([ \t]*)include[ \t]+/etc/nginx/blackoutburst-platform/public[.]conf;[ \t]*(?:#[^\r\n]*)?\n?'
    match=re.fullmatch(expression,line)
    require(match is not None,'ANCHOR_LINE_MISMATCH')
    indent=match.group(1)
    prefix=indent+b'# Personal Agent account-only preview 20261101 v3\n'+indent+b'include /etc/nginx/personal-agent-preview.locations;\n'
    return data[:offset]+prefix+data[offset:]

def verify_nginx_delta(before, after, qualification, proxy):
    require(set(after)==set(before)|{str(INCLUDE)},'NGINX_CAPTURED_SOURCE_SET_CHANGED')
    normalize=lambda text: text.replace('\r\n','\n').rstrip('\n')
    for name,body in before.items():
        expected=insert_preview_anchor(body.encode('utf-8'),qualification).decode('utf-8') if name==str(TARGET_SECTION) else body
        require(normalize(after[name])==normalize(expected),'NGINX_UNEXPECTED_SOURCE_DELTA')
    require(normalize(after[str(INCLUDE)])==normalize(proxy.decode()),'NGINX_NEW_INCLUDE_MISMATCH')

def rollback(receipt):
    # Touch only files matching this installer's exact recorded bytes.
    verify_target_binding()
    require(QUALIFIER_NAMESPACE is not None,'ROLLBACK_QUALIFIER_UNAVAILABLE')
    baseline=receipt.get('_private',{}).get('baseline_snapshot')
    require(isinstance(baseline,dict) and str(TARGET_SECTION) in baseline,'ROLLBACK_BASELINE_UNAVAILABLE')
    other_paths=[name for name in baseline if name!=str(TARGET_SECTION)]
    require(nginx_snapshot(other_paths)=={name:value for name,value in baseline.items() if name!=str(TARGET_SECTION)},'ROLLBACK_OTHER_SOURCE_DRIFT')
    current=None
    if TARGET.exists():
        current=digest(read_file(TARGET,owner=0))
        require(current in (receipt['target_before_sha256'],receipt['target_after_sha256']),'TARGET_CONFIG_DRIFT')
    else: raise Refused('TARGET_CONFIG_MISSING')
    original=read_file(BACKUP,receipt['target_before_sha256'],0)
    for path,key in [(UNIT,'unit_sha256'),(INCLUDE,'proxy_sha256')]:
        if path.exists() or path.is_symlink():
            read_file(path,receipt[key],0)
    current_dump=run([NGINX,'-T'],accepted=(0,1))
    if current_dump.returncode==0:
        sections=QUALIFIER_NAMESPACE['nginx_dump_sections'](current_dump.stdout)
        require(set(baseline)<=set(sections)<=set(baseline)|{str(INCLUDE)},'ROLLBACK_LOADED_SOURCE_SET_DRIFT')
        require(sections[str(TARGET_SECTION)].encode('utf-8').rstrip(b'\n')==read_file(TARGET,owner=0).rstrip(b'\n'),'ROLLBACK_LOADED_CAPTURE_DRIFT')
    # All affected hashes are qualified before the first mutation.
    if current==receipt['target_after_sha256']:
        replace_file(TARGET,current,original,receipt['target_mode'],0,receipt['target_gid'])
    restored_dump=run([NGINX,'-T']).stdout
    require(digest(restored_dump.encode())==receipt['nginx_baseline_dump_sha256'],'ROLLBACK_BASELINE_CONTEXT_DRIFT')
    verify_nginx_service()
    run([SYSTEMCTL,'reload','nginx'])
    if UNIT.exists():
        run([SYSTEMCTL,'daemon-reload'])
        state=show_properties(SERVICE,['MainPID','ControlPID','ActiveState'])
        if state.get('MainPID')!='0' or state.get('ControlPID')!='0' or state.get('ActiveState') not in ('inactive','failed'):
            verify_effective_unit(Path('/home/ubuntu/personal-agent/releases')/receipt['commit'])
            run([SYSTEMCTL,'stop',SERVICE],accepted=(0,5))
        remove_owned(UNIT,receipt['unit_sha256'])
    if INCLUDE.exists():
        remove_owned(INCLUDE,receipt['proxy_sha256'])
    run([SYSTEMCTL,'daemon-reload'])
    receipt['phase']='rolled_back'; save_receipt(receipt)

def validate_prior_rollback(manifest, nginx_dump, before_snapshot):
    """Accept only the pinned, cleanly rolled-back anonymous-denial v2 attempt."""
    try:
        user = pwd.getpwnam('ubuntu')
        check_ancestors(PRIOR_STAGE)
        check_directory(PRIOR_STAGE, user.pw_uid, True)
        prior_manifest_bytes = read_file(PRIOR_STAGE / 'operator-manifest.json', PRIOR_MANIFEST_SHA, user.pw_uid)
        prior_installer_bytes = read_file(PRIOR_STAGE / 'install-account-preview-v2.py', PRIOR_INSTALLER_SHA, user.pw_uid)
        prior_manifest = json.loads(prior_manifest_bytes)
        require(isinstance(prior_manifest, dict) and prior_manifest.get('schema_version') == 2,
                'PRIOR_MANIFEST_SCHEMA_INVALID')
        require(isinstance(manifest, dict), 'RETRY_MANIFEST_INVALID')
        for field in ('commit', 'release', 'archive_sha256', 'unit_sha256', 'proxy_sha256', 'target_before_sha256'):
            require(field in prior_manifest and manifest.get(field) == prior_manifest[field], 'PRIOR_RELEASE_IDENTITY_DRIFT')
        sources = prior_manifest.get('source_sha256')
        require(isinstance(sources, dict) and len(sources) == 28 and manifest.get('source_sha256') == sources,
                'PRIOR_SOURCE_IDENTITY_DRIFT')
        for field, expected in (('target_section', str(TARGET_SECTION)), ('canonical_target', str(TARGET)),
                                ('reserved_include', str(INCLUDE))):
            require(prior_manifest.get(field) == expected and manifest.get(field) == expected,
                    'PRIOR_TARGET_IDENTITY_DRIFT')

        for path in (PRIOR_RECEIPT, PRIOR_BACKUP):
            check_ancestors(path)
            check_directory(path.parent, 0, True)
            require(stat.S_IMODE(path.lstat().st_mode) == 0o600, 'PRIOR_EVIDENCE_NOT_PRIVATE')
        prior_receipt_bytes = read_file(PRIOR_RECEIPT, owner=0)
        prior = json.loads(prior_receipt_bytes)
        require(isinstance(prior, dict), 'PRIOR_RECEIPT_INVALID')
        require(prior.get('phase') == 'rolled_back' and prior.get('failure_reason') == 'ANONYMOUS_DENIAL_FAILED'
                and prior.get('recovery_reason') is None, 'PRIOR_ATTEMPT_NOT_SUPPORTED')
        require(prior.get('manifest_sha256') == PRIOR_MANIFEST_SHA and prior.get('receipt') == str(PRIOR_RECEIPT),
                'PRIOR_RECEIPT_IDENTITY_DRIFT')
        for receipt_field, manifest_field in (('commit', 'commit'), ('source_archive_sha256', 'archive_sha256'),
                                              ('unit_sha256', 'unit_sha256'), ('proxy_sha256', 'proxy_sha256'),
                                              ('target_before_sha256', 'target_before_sha256'),
                                              ('target_section', 'target_section'), ('canonical_target', 'canonical_target')):
            require(prior.get(receipt_field) == prior_manifest.get(manifest_field), 'PRIOR_RECEIPT_IDENTITY_DRIFT')
        require(prior.get('private_pilot_validated') is True and type(prior.get('pilot_count')) is int
                and prior['pilot_count'] == 2 and prior.get('shared_public_preserved') is True
                and prior.get('boot_enabled') is False and prior.get('provider_runtime_activated') is False
                and prior.get('real_pilot_signin_accepted') is False, 'PRIOR_SCOPE_IDENTITY_DRIFT')

        state = show_properties(SERVICE, ['LoadState', 'MainPID', 'ControlPID', 'ActiveState'])
        require(state.get('LoadState') == 'not-found' and state.get('MainPID') == '0' and state.get('ControlPID') == '0'
                and state.get('ActiveState') in ('inactive', 'failed'), 'PRIOR_SERVICE_STILL_ACTIVE')
        require(isinstance(nginx_dump, str) and digest(nginx_dump.encode('utf-8')) == prior.get('nginx_baseline_dump_sha256'),
                'PRIOR_NGINX_BASELINE_DRIFT')
        private = prior.get('_private')
        baseline = private.get('baseline_snapshot') if isinstance(private, dict) else None
        require(isinstance(baseline, dict) and 1 <= len(baseline) <= 512 and isinstance(before_snapshot, dict)
                and set(before_snapshot) == set(baseline) and str(TARGET_SECTION) in baseline,
                'PRIOR_SOURCE_SET_DRIFT')
        for name, original_record in baseline.items():
            current_record = before_snapshot[name]
            require(isinstance(original_record, dict) and isinstance(current_record, dict)
                    and set(original_record) == set(current_record) == {'resolved', 'device', 'inode', 'sha256'},
                    'PRIOR_SNAPSHOT_INVALID')
            if name == str(TARGET_SECTION):
                require({key: value for key, value in original_record.items() if key != 'inode'} ==
                        {key: value for key, value in current_record.items() if key != 'inode'}, 'PRIOR_TARGET_SNAPSHOT_DRIFT')
                require(current_record['resolved'] == str(TARGET)
                        and current_record['sha256'] == prior['target_before_sha256'], 'PRIOR_TARGET_SNAPSHOT_DRIFT')
            else:
                require(current_record == original_record, 'PRIOR_OTHER_SOURCE_DRIFT')
        require(verify_target_binding() == {str(TARGET_SECTION): before_snapshot[str(TARGET_SECTION)]},
                'PRIOR_TARGET_BINDING_DRIFT')
        restored = read_file(TARGET, prior['target_before_sha256'], 0)
        info = TARGET.lstat()
        require(type(prior.get('target_mode')) is int and type(prior.get('target_gid')) is int
                and stat.S_IMODE(info.st_mode) == prior['target_mode'] and info.st_gid == prior['target_gid'],
                'PRIOR_TARGET_METADATA_DRIFT')
        backup = read_file(PRIOR_BACKUP, prior['target_before_sha256'], 0)
        require(backup == restored, 'PRIOR_BACKUP_DRIFT')

        check_ancestors(PILOT)
        check_directory(PILOT.parent, user.pw_uid, True)
        try:
            pilot = PILOT.lstat()
        except FileNotFoundError:
            raise Refused('PRIOR_PRIVATE_PILOT_REQUIRED') from None
        require(stat.S_ISREG(pilot.st_mode) and not PILOT.is_symlink() and pilot.st_nlink == 1
                and pilot.st_uid == user.pw_uid and stat.S_IMODE(pilot.st_mode) == 0o600
                and pilot.st_size <= 16 * 1024, 'PRIOR_PRIVATE_PILOT_METADATA_INVALID')
        return {'prior_version': 2, 'prior_phase': 'rolled_back', 'prior_receipt_sha256': digest(prior_receipt_bytes),
                'prior_manifest_sha256': digest(prior_manifest_bytes), 'prior_installer_sha256': digest(prior_installer_bytes),
                'prior_backup_sha256': digest(backup), 'preserved': True}
    except Refused:
        raise
    except Exception:
        raise Refused('PRIOR_ROLLBACK_VALIDATION_UNAVAILABLE') from None

def main():
    global QUALIFIER_NAMESPACE
    require(os.geteuid()==0,'ROOT_OPERATOR_REQUIRED')
    require(sys.argv[1:] in ([],['--rollback']),'UNKNOWN_OPTION')
    os.umask(0o077)
    user=pwd.getpwnam('ubuntu')
    check_ancestors(STAGE); check_directory(STAGE,user.pw_uid,True)
    manifest=json.loads(read_file(STAGE/'operator-manifest.json',MANIFEST_SHA,user.pw_uid))
    release=Path(manifest['release'])
    require(release==Path('/home/ubuntu/personal-agent/releases')/manifest['commit'],'RELEASE_PATH_INVALID')
    check_ancestors(release); check_directory(release,user.pw_uid,True)
    parser=read_file(STAGE/'nginx_preview_vhost_context.py',PARSER_SHA,user.pw_uid)
    namespace={'__name__':'staging_context','__file__':str(STAGE/'nginx_preview_vhost_context.py')}
    exec(compile(parser,str(STAGE/'nginx_preview_vhost_context.py'),'exec'),namespace)
    QUALIFIER_NAMESPACE=namespace
    if not RECEIPT_DIR.exists(): RECEIPT_DIR.mkdir(mode=0o700)
    check_ancestors(RECEIPT_DIR)
    check_directory(RECEIPT_DIR,0,True)
    require(not any(p.exists() or p.is_symlink() for p in (OLD_RECEIPT,OLD_BACKUP,OLD_INCLUDE)),'V1_ARTIFACTS_REQUIRE_REVIEW')
    lock=os.open(RECEIPT_DIR/'operator.lock',os.O_RDWR|os.O_CREAT|os.O_NOFOLLOW,0o600)
    lock_info=os.fstat(lock)
    require(stat.S_ISREG(lock_info.st_mode) and lock_info.st_uid==0 and lock_info.st_nlink==1 and stat.S_IMODE(lock_info.st_mode)==0o600,'UNSAFE_OPERATOR_LOCK')
    fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB)
    if RECEIPT.exists():
        receipt=json.loads(read_file(RECEIPT,owner=0))
        require(receipt.get('manifest_sha256')==MANIFEST_SHA,'RECEIPT_MISMATCH')
        if sys.argv[1:]==['--rollback']:
            rollback(receipt); print(json.dumps({'phase':'rolled_back','receipt':str(RECEIPT)})); return
        require(receipt.get('phase')=='verified','INCOMPLETE_PRIOR_INSTALL_REQUIRES_REVIEW_OR_ROLLBACK')
        for path,key in [(UNIT,'unit_sha256'),(INCLUDE,'proxy_sha256'),(TARGET,'target_after_sha256')]:
            read_file(path,receipt[key],0)
        for relative,expected in manifest['source_sha256'].items(): read_file(release/relative,expected,user.pw_uid)
        require(digest(run([NGINX,'-T']).stdout.encode())==receipt['nginx_installed_dump_sha256'],'NGINX_INSTALLED_CONTEXT_DRIFT')
        verify_target_binding(); verify_effective_unit(release); verify_nginx_service(); verify_service(release); verify_routes()
        print(json.dumps(public_receipt(receipt))); return
    require(not sys.argv[1:],'NO_PRIOR_INSTALL_TO_ROLL_BACK')
    for relative,expected in manifest['source_sha256'].items():
        path=release/relative
        require(path.resolve().is_relative_to(release),'SOURCE_PATH_INVALID')
        read_file(path,expected,user.pw_uid)
    require(not UNIT.exists() and not UNIT.is_symlink() and not INCLUDE.exists() and not INCLUDE.is_symlink(),'EXISTING_INSTALLATION_REQUIRES_REVIEW')
    require('LoadState=not-found' in run([SYSTEMCTL,'show',SERVICE,'-p','LoadState']).stdout,'UNIT_NAME_ALREADY_USED')
    verify_nginx_service()
    require(not port_listeners(),'PREVIEW_PORT_ALREADY_OCCUPIED')
    read_file(Path(NODE),owner=0,maximum=160*1024*1024)
    require(run([NODE,'--version']).stdout.strip()=='v24.22.1','NODE_VERSION_CHANGED')
    check_ancestors(TARGET); check_directory(TARGET.parent,0); check_directory(INCLUDE.parent,0)
    verify_target_binding()
    original=read_file(TARGET,manifest['target_before_sha256'],0)
    require(b'\r' not in original,'TARGET_LINE_ENDINGS_UNSUPPORTED')
    nginx=run([NGINX,'-T'])
    try: qualification=namespace['qualify_nginx_dump'](nginx.stdout)
    except Exception:
        diagnostic_source=read_file(STAGE/'nginx_preview_vhost_diagnostic.py',DIAGNOSTIC_SHA,user.pw_uid)
        diagnostic_namespace={'__name__':'staging_vhost_diagnostic','__file__':str(STAGE/'nginx_preview_vhost_diagnostic.py')}
        exec(compile(diagnostic_source,str(STAGE/'nginx_preview_vhost_diagnostic.py'),'exec'),diagnostic_namespace)
        report=diagnostic_namespace['diagnose_nginx_dump'](nginx.stdout,qualifier_path=STAGE/'nginx_preview_vhost_context.py')
        raise Refused('NGINX_VHOST_CONTEXT_REQUIRES_REVIEW',report) from None
    require(qualification['target_section']==str(TARGET_SECTION) and qualification['canonical_target']==str(TARGET) and qualification['reserved_include']==str(INCLUDE),'QUALIFIER_TARGET_MISMATCH')
    before_sections=namespace['nginx_dump_sections'](nginx.stdout)
    require(before_sections[str(TARGET_SECTION)].encode('utf-8').rstrip(b'\n')==original.rstrip(b'\n'),'TARGET_CAPTURE_MISMATCH')
    before_snapshot=nginx_snapshot(qualification['captured_paths'])
    prior_rollback=validate_prior_rollback(manifest,nginx.stdout,before_snapshot)
    check_ancestors(PILOT); check_directory(PILOT.parent,user.pw_uid,True); check_directory(DATA,user.pw_uid,True)
    code="import {loadPilotSubjects} from './src/pilot-config.mjs'; const p=loadPilotSubjects('/home/ubuntu/personal-agent-config/pilot.json',process.cwd()); if(p.length!==2) process.exit(2); console.log('pilot_configuration_valid');"
    result=subprocess.run(['/usr/sbin/runuser','-u','ubuntu','--',NODE,'--input-type=module','--eval',code],cwd=release,capture_output=True,text=True,timeout=10,env={'PATH':'/usr/bin:/bin','LANG':'C.UTF-8'})
    require(result.returncode==0 and result.stdout.strip()=='pilot_configuration_valid','PRIVATE_PILOT_VALIDATION_FAILED')
    unit=read_file(STAGE/'personal-agent-account.service',manifest['unit_sha256'],user.pw_uid)
    proxy=read_file(STAGE/'personal-agent-preview.conf',manifest['proxy_sha256'],user.pw_uid)
    require(proxy.count(b'access_log off;')==2 and b'location = /personal-agent-preview {' in proxy and b'location ^~ /personal-agent-preview/ {' in proxy,'PROXY_BOUNDARY_INVALID')
    inserted=insert_preview_anchor(original,qualification)
    # Private terminal entry can take time: qualify the complete context again.
    require(nginx_snapshot(qualification['captured_paths'])==before_snapshot,'NGINX_BASELINE_DRIFT')
    require(run([NGINX,'-T']).stdout==nginx.stdout,'NGINX_CONTEXT_CHANGED_DURING_PRIVATE_ENTRY')
    info=TARGET.lstat()
    receipt={'phase':'prepared','manifest_sha256':MANIFEST_SHA,'commit':manifest['commit'],'source_archive_sha256':manifest['archive_sha256'],
        'unit_sha256':digest(unit),'proxy_sha256':digest(proxy),'target_before_sha256':digest(original),'target_after_sha256':digest(inserted),
        'target_mode':stat.S_IMODE(info.st_mode),'target_gid':info.st_gid,'private_pilot_validated':True,'pilot_count':2,
        'nginx_baseline_dump_sha256':digest(nginx.stdout.encode()),'target_section':str(TARGET_SECTION),'canonical_target':str(TARGET),'shared_public_preserved':True,
        '_private':{'baseline_snapshot':before_snapshot},'prior_rollback':prior_rollback,
        'boot_enabled':False,'provider_runtime_activated':False,'real_pilot_signin_accepted':False,'receipt':str(RECEIPT)}
    require(not BACKUP.exists() and not BACKUP.is_symlink(),'EXISTING_BACKUP_REQUIRES_REVIEW')
    write_new(BACKUP,original)
    save_receipt(receipt)
    try:
        receipt['phase']='installing'; save_receipt(receipt)
        write_new(UNIT,unit,0o644); write_new(INCLUDE,proxy,0o644)
        replace_file(TARGET,receipt['target_before_sha256'],inserted,receipt['target_mode'],0,receipt['target_gid'])
        after_dump=run([NGINX,'-T']).stdout
        verify_nginx_delta(before_sections,namespace['nginx_dump_sections'](after_dump),qualification,proxy)
        unchanged_paths=[name for name in qualification['captured_paths'] if name!=str(TARGET_SECTION)]
        require(nginx_snapshot(unchanged_paths)=={name:value for name,value in before_snapshot.items() if name!=str(TARGET_SECTION)},'NGINX_OTHER_SOURCE_DRIFT')
        for relative,expected in manifest['source_sha256'].items(): read_file(release/relative,expected,user.pw_uid)
        run([SYSTEMCTL,'daemon-reload']); verify_effective_unit(release); run([SYSTEMCTL,'start',SERVICE])
        deadline=time.monotonic()+15
        while True:
            try: pid=verify_service(release); break
            except (Refused,urllib.error.URLError,ConnectionError):
                if time.monotonic()>=deadline: raise
                time.sleep(0.5)
        require(run([NGINX,'-T']).stdout==after_dump,'NGINX_CHANGED_BEFORE_RELOAD')
        verify_nginx_service()
        run([SYSTEMCTL,'reload','nginx'])
        receipt['checks']=verify_routes(); receipt['main_pid']=pid
        receipt['nginx_installed_dump_sha256']=digest(after_dump.encode())
        receipt['phase']='verified'; receipt['verified_at_utc']=time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())
        save_receipt(receipt); print(json.dumps(public_receipt(receipt)))
    except Exception as error:
        receipt['failure_reason']=str(error) if isinstance(error,Refused) else 'UNEXPECTED_INSTALLATION_FAILURE'
        if isinstance(error,Refused) and error.diagnostic is not None: receipt['failure_diagnostic']=error.diagnostic
        try: rollback(receipt)
        except Exception as recovery:
            receipt['phase']='recovery_required'
            receipt['recovery_reason']=str(recovery) if isinstance(recovery,Refused) else 'UNEXPECTED_RECOVERY_FAILURE'
            save_receipt(receipt)
        raise Refused('INSTALLATION_FAILED',{'diagnostic_only':True,'failure_reason':receipt['failure_reason'],
            'failure_diagnostic':receipt.get('failure_diagnostic'),
            'recovery_phase':receipt['phase'],'recovery_reason':receipt.get('recovery_reason')}) from None

if __name__=='__main__':
    try: main()
    except Exception as error:
        code=str(error) if isinstance(error,Refused) else 'OPERATOR_INSTALL_REFUSED'
        report={'phase':'refused','reason':code,'receipt':str(RECEIPT)}
        if isinstance(error,Refused) and error.diagnostic is not None: report['diagnostic']=error.diagnostic
        print(json.dumps(report),file=sys.stderr)
        sys.exit(1)
