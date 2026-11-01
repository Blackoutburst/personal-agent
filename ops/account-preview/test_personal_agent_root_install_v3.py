"""Synthetic installer guard/rollback checks; never run a privileged command."""
import ast, importlib.util, json, os, tempfile, unittest
from pathlib import Path
from contextlib import contextmanager
from types import SimpleNamespace
from unittest.mock import patch

SPEC=importlib.util.spec_from_file_location('preview_installer',Path(__file__).with_name('personal-agent-root-install-v3.template.py'))
INSTALL=importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)

class Guards(unittest.TestCase):
    def test_file_hash_type_links_owner_and_size_fail_closed(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory); path=root/'source'; path.write_bytes(b'expected')
            self.assertEqual(INSTALL.read_file(path,INSTALL.digest(b'expected'),os.getuid()),b'expected')
            for options in ({'expected':'bad'},{'owner':os.getuid()+1},{'maximum':2}):
                with self.assertRaises(INSTALL.Refused): INSTALL.read_file(path,**options)
            link=root/'symlink'; link.symlink_to(path)
            with self.assertRaises(INSTALL.Refused): INSTALL.read_file(link)
            hard=root/'hardlink'; os.link(path,hard)
            with self.assertRaises(INSTALL.Refused): INSTALL.read_file(path)
            with self.assertRaises(INSTALL.Refused): INSTALL.read_file(root)

    def test_postwrite_dump_allows_only_root_anchor_insertion_and_one_new_include(self):
        root=str(INSTALL.TARGET_SECTION); include=str(INSTALL.INCLUDE)
        anchor=b'    include /etc/nginx/blackoutburst-platform/public.conf; # shared\n'
        body=b'# root preamble\nserver {\n'+anchor+b'}\n'
        qualification={'anchor_byte_offset':body.index(anchor)}
        before={'/etc/nginx/nginx.conf':'http { ... }\n',root:body.decode()+'\n',
            INSTALL.PUBLIC_ANCHOR:'shared PUBLIC bytes\n','/etc/nginx/sites-enabled/games.blackoutburst.com':'Games bytes\n'}
        proxy=b'location = /personal-agent-preview { access_log off; }\n'
        inserted=INSTALL.insert_preview_anchor(body,qualification)
        self.assertEqual(inserted.replace(b'    # Personal Agent account-only preview 20261101 v3\n    include /etc/nginx/personal-agent-preview.locations;\n',b''),body)
        after={**before,root:inserted.decode()+'\n',include:proxy.decode()+'\n'}
        INSTALL.verify_nginx_delta(before,after,qualification,proxy)
        variants=[{**after,'/etc/nginx/unexpected.conf':'new'},
            {**after,'/etc/nginx/nginx.conf':'http { changed }'},
            {**after,root:before[root]}, {**after,include:'different'},
            {**after,INSTALL.PUBLIC_ANCHOR:'changed shared PUBLIC'},
            {**after,'/etc/nginx/sites-enabled/games.blackoutburst.com':'changed Games'}]
        for changed in variants:
            with self.assertRaises(INSTALL.Refused): INSTALL.verify_nginx_delta(before,changed,qualification,proxy)

    def test_anchor_is_byte_exact_and_refuses_wrong_line_or_offset(self):
        anchor=b'\tinclude /etc/nginx/blackoutburst-platform/public.conf;\n'
        prefix='# multibyte café and separator \u2028 remains a comment\n'.encode()
        body=prefix+anchor
        inserted=INSTALL.insert_preview_anchor(body,{'anchor_byte_offset':len(prefix)})
        self.assertTrue(inserted.startswith(prefix))
        self.assertTrue(inserted.endswith(anchor))
        for offset in [-1,True,len(prefix)+1,len(body),0]:
            with self.assertRaises(INSTALL.Refused): INSTALL.insert_preview_anchor(body,{'anchor_byte_offset':offset})
        for wrong in [b' include /etc/nginx/other.conf;\n',b'# include /etc/nginx/blackoutburst-platform/public.conf;\n',anchor.replace(b'\n',b'\r\n')]:
            with self.assertRaises(INSTALL.Refused): INSTALL.insert_preview_anchor(wrong,{'anchor_byte_offset':0})

    def test_v1_and_v2_ownership_records_are_distinct(self):
        self.assertNotEqual(INSTALL.OLD_BACKUP,INSTALL.BACKUP)
        self.assertNotEqual(INSTALL.OLD_RECEIPT,INSTALL.RECEIPT)
        self.assertNotEqual(INSTALL.OLD_INCLUDE,INSTALL.INCLUDE)
        self.assertEqual(INSTALL.PUBLIC_ANCHOR,'/etc/nginx/blackoutburst-platform/public.conf')

    def test_effective_unit_refuses_dropins_hooks_commands_and_extra_dependencies(self):
        release=Path('/home/ubuntu/personal-agent/releases/test-commit')
        props={'LoadState':'loaded','FragmentPath':str(INSTALL.UNIT),'DropInPaths':'','User':'ubuntu','Group':'ubuntu',
            'WorkingDirectory':str(release),'ExecStart':'{ path='+INSTALL.NODE+' ; argv[]='+INSTALL.NODE+' '+str(release/'server.mjs')+' ; ignore_errors=no ; pid=0 ; }',
            'Requires':'-.mount sysinit.target system.slice','Wants':'tmp.mount','Conflicts':'shutdown.target','Before':'shutdown.target'}
        INSTALL.validate_unit_properties(props,release)
        for field,value in [('DropInPaths','/unreviewed.conf'),('ExecStartPre','private-hook-marker'),('ExecStop','unexpected'),
            ('ExecCondition','unexpected'),('User','root'),('Group','root'),('WorkingDirectory','/other'),
            ('Requires','other.service'),('Wants','other.service'),('PartOf','other.service'),('Before','other.target'),
            ('Conflicts','other.service'),('FailureAction','reboot'),('EnvironmentFiles','private-marker')]:
            with self.assertRaises(INSTALL.Refused): INSTALL.validate_unit_properties({**props,field:value},release)
        with self.assertRaises(INSTALL.Refused): INSTALL.one_command(props['ExecStart']+' '+props['ExecStart'])

    def test_public_receipt_excludes_private_operator_context(self):
        receipt={'phase':'verified','commit':'public-version','_private':{'baseline_snapshot':{'private-path-marker':'private-hash-marker'}}}
        public=INSTALL.public_receipt(receipt)
        self.assertEqual(public,{'phase':'verified','commit':'public-version'})
        self.assertNotIn('private-',json.dumps(public))

    def test_actual_nginx_master_command_cannot_keep_an_older_custom_configuration(self):
        binary=INSTALL.NGINX.encode()
        INSTALL.validate_nginx_master_command(binary+b'\0-g\0daemon on; master_process on;\0')
        title=b'nginx: master process '+binary+b' -g daemon on; master_process on;'
        INSTALL.validate_nginx_master_command(title+b'\0\0')
        for value in [title+b' -c /private/other.conf',title+b' -p /other-prefix',
            b'nginx: master process '+binary+b' -g daemon on; master_process on; include /other.conf;',
            binary+b'\0-c\0/other.conf\0',b'unknown-master']:
            with self.assertRaises(INSTALL.Refused): INSTALL.validate_nginx_master_command(value)

    def test_write_new_is_exclusive_and_preserves_existing_bytes(self):
        with tempfile.TemporaryDirectory() as directory:
            path=Path(directory)/'retained'
            INSTALL.write_new(path,b'first',owner=os.getuid(),group=os.getgid())
            with self.assertRaises(FileExistsError): INSTALL.write_new(path,b'second',owner=os.getuid(),group=os.getgid())
            self.assertEqual(path.read_bytes(),b'first')

class Rollback(unittest.TestCase):
    def fixture(self):
        temporary=tempfile.TemporaryDirectory(); self.addCleanup(temporary.cleanup)
        root=Path(temporary.name)
        paths={key:root/name for key,name in [('TARGET','root-vhost.conf'),('TARGET_SECTION','loaded-vhost'),('UNIT','preview.service'),('INCLUDE','preview.conf'),('BACKUP','before.conf'),('RECEIPT','receipt.json')]}
        original=b'original nginx bytes\n'; modified=b'new include\n'+original
        unit=b'owned unit\n'; proxy=b'owned proxy\n'
        for key,data in [('TARGET',modified),('UNIT',unit),('INCLUDE',proxy),('BACKUP',original)]: paths[key].write_bytes(data)
        paths['TARGET_SECTION'].symlink_to(paths['TARGET'])
        baseline_dump=json.dumps({str(paths['TARGET_SECTION']):original.decode()},sort_keys=True)
        receipt={'phase':'installing','target_before_sha256':INSTALL.digest(original),'target_after_sha256':INSTALL.digest(modified),
            'unit_sha256':INSTALL.digest(unit),'proxy_sha256':INSTALL.digest(proxy),'target_mode':0o600,'target_gid':os.getgid(),
            'commit':'test-commit','nginx_baseline_dump_sha256':INSTALL.digest(baseline_dump.encode()),
            '_private':{'baseline_snapshot':{str(paths['TARGET_SECTION']):{'sha256':INSTALL.digest(original)}}}}
        return paths,receipt,original,modified

    def patches(self,paths,commands):
        actual_read=INSTALL.read_file; actual_write=INSTALL.write_new; actual_replace=INSTALL.replace_file
        def read(path,expected=None,owner=None,maximum=4*1024*1024):
            return actual_read(path,expected,os.getuid() if owner==0 else owner,maximum)
        def write(path,data,mode=0o600,owner=0,group=0):
            return actual_write(path,data,mode,os.getuid(),os.getgid())
        def replace(path,expected,data,mode=0o600,owner=0,group=0):
            return actual_replace(path,expected,data,mode,os.getuid(),os.getgid())
        def binding():
            INSTALL.require(paths['TARGET_SECTION'].is_symlink() and paths['TARGET_SECTION'].resolve()==paths['TARGET'],'TARGET_LOADED_ALIAS_CHANGED')
        def snapshot(names):
            return {name:{'sha256':INSTALL.digest(Path(name).read_bytes())} for name in names}
        def run(args,**kwargs):
            commands.append(args)
            if args==[INSTALL.NGINX,'-T']:
                sections={str(paths['TARGET_SECTION']):paths['TARGET'].read_text()}
                if INSTALL.digest(paths['TARGET'].read_bytes())!=INSTALL.digest(paths['BACKUP'].read_bytes()) and paths['INCLUDE'].exists():
                    sections[str(paths['INCLUDE'])]=paths['INCLUDE'].read_text()
                return SimpleNamespace(stdout=json.dumps(sections,sort_keys=True),returncode=0)
            if args[:3]==[INSTALL.SYSTEMCTL,'show',INSTALL.SERVICE]:
                return SimpleNamespace(stdout='MainPID=123\nControlPID=0\nActiveState=active\n',returncode=0)
            return SimpleNamespace(stdout='',returncode=0)
        return [patch.multiple(INSTALL,**paths),patch.object(INSTALL,'read_file',read),patch.object(INSTALL,'write_new',write),
            patch.object(INSTALL,'replace_file',replace),patch.object(INSTALL,'verify_target_binding',binding),
            patch.object(INSTALL,'nginx_snapshot',snapshot),patch.object(INSTALL,'QUALIFIER_NAMESPACE',{'nginx_dump_sections':json.loads}),
            patch.object(INSTALL,'verify_nginx_service',lambda:None),patch.object(INSTALL,'verify_effective_unit',lambda release:None),patch.object(INSTALL,'run',run)]

    def test_unit_drift_refuses_before_any_restore_or_command(self):
        paths,receipt,original,modified=self.fixture(); paths['UNIT'].write_bytes(b'not installer-owned')
        commands=[]
        managers=self.patches(paths,commands)
        for manager in managers: manager.start(); self.addCleanup(manager.stop)
        with self.assertRaises(INSTALL.Refused): INSTALL.rollback(receipt)
        self.assertEqual(paths['TARGET'].read_bytes(),modified)
        self.assertEqual(commands,[])
        self.assertTrue(paths['INCLUDE'].exists())

    def test_public_drift_refuses_without_removing_the_owned_unit(self):
        paths,receipt,_,_=self.fixture(); paths['TARGET'].write_bytes(b'operator changed this')
        commands=[]
        for manager in self.patches(paths,commands): manager.start(); self.addCleanup(manager.stop)
        with self.assertRaises(INSTALL.Refused): INSTALL.rollback(receipt)
        self.assertTrue(paths['UNIT'].exists()); self.assertEqual(commands,[])

    def test_owned_rollback_restores_nginx_then_stops_only_the_new_unit(self):
        paths,receipt,original,_=self.fixture(); commands=[]
        for manager in self.patches(paths,commands): manager.start(); self.addCleanup(manager.stop)
        INSTALL.rollback(receipt)
        self.assertEqual(paths['TARGET'].read_bytes(),original)
        self.assertFalse(paths['UNIT'].exists()); self.assertFalse(paths['INCLUDE'].exists())
        self.assertEqual(json.loads(paths['RECEIPT'].read_text())['phase'],'rolled_back')
        self.assertLess(commands.index([INSTALL.SYSTEMCTL,'reload','nginx']),commands.index([INSTALL.SYSTEMCTL,'stop',INSTALL.SERVICE]))
        self.assertTrue(paths['BACKUP'].exists())

    def test_retargeted_loaded_alias_refuses_before_any_restore(self):
        paths,receipt,_,modified=self.fixture(); other=paths['TARGET'].with_name('other-vhost'); other.write_bytes(b'other')
        paths['TARGET_SECTION'].unlink(); paths['TARGET_SECTION'].symlink_to(other)
        commands=[]
        for manager in self.patches(paths,commands): manager.start(); self.addCleanup(manager.stop)
        with self.assertRaises(INSTALL.Refused): INSTALL.rollback(receipt)
        self.assertEqual(paths['TARGET'].read_bytes(),modified); self.assertEqual(commands,[])

    def test_other_source_drift_refuses_before_any_restore(self):
        paths,receipt,_,modified=self.fixture(); shared=paths['TARGET'].with_name('shared-public.conf'); shared.write_bytes(b'changed')
        receipt['_private']['baseline_snapshot'][str(shared)]={'sha256':INSTALL.digest(b'original')}
        commands=[]
        for manager in self.patches(paths,commands): manager.start(); self.addCleanup(manager.stop)
        with self.assertRaises(INSTALL.Refused): INSTALL.rollback(receipt)
        self.assertEqual(paths['TARGET'].read_bytes(),modified); self.assertEqual(commands,[])

    def test_unknown_postrestore_dump_never_reloads_nginx(self):
        paths,receipt,_,_=self.fixture(); commands=[]
        for manager in self.patches(paths,commands): manager.start(); self.addCleanup(manager.stop)
        actual_run=INSTALL.run; reads=0
        def changed_dump(args,**kwargs):
            nonlocal reads
            result=actual_run(args,**kwargs)
            if args==[INSTALL.NGINX,'-T']:
                reads+=1
                if reads>1:
                    data=json.loads(result.stdout); data['/unexpected-source']='new-vhost'
                    return SimpleNamespace(stdout=json.dumps(data,sort_keys=True),returncode=0)
            return result
        with patch.object(INSTALL,'run',changed_dump):
            with self.assertRaises(INSTALL.Refused): INSTALL.rollback(receipt)
        self.assertNotIn([INSTALL.SYSTEMCTL,'reload','nginx'],commands)
        self.assertTrue(paths['UNIT'].exists())

class RouteChecks(unittest.TestCase):
    PUBLIC='https://blackoutburst.com/personal-agent-preview'
    READY=json.dumps({'service':{'mode':'account'},'adapters':{
        'provider':{'state':'unavailable'},'runtime':{'state':'unavailable'}}}).encode()
    DENIED=(401,{'cache-control':'no-store'},b'{"error":{"code":"AUTHENTICATION_REQUIRED"}}')

    @contextmanager
    def fixture(self, readiness=None, overrides=None):
        calls=[]; sleeps=[]; now=[0]
        readiness=list(readiness or [(200,{'cache-control':'no-store'},self.READY)])
        overrides=overrides or {}
        def probe(url,method='GET',headers=None,body=None,timeout=5):
            calls.append((url,method,headers,body,timeout))
            if url.endswith('/api/session'):
                label='public' if url.startswith(self.PUBLIC) else 'local'
                leg=label+('_invalid_cookie' if (headers or {}).get('Cookie') else '_anonymous')
                self.assertEqual(method,'POST'); self.assertEqual(body,b'{}')
                self.assertEqual(headers['Origin'],'https://blackoutburst.com')
                self.assertEqual(headers['Content-Type'],'application/json')
                return overrides.get(leg,self.DENIED)
            if url==self.PUBLIC+'/api/status':
                return readiness.pop(0) if len(readiness)>1 else readiness[0]
            if url==self.PUBLIC: return 302,{'location':'/personal-agent-preview/'},b''
            if url in [self.PUBLIC+asset for asset in ['/','/app.js','/styles.css']]: return 200,{},b'asset'
            if url=='http://127.0.0.1:9011/healthz': return overrides.get('account_health',(200,{},b'{"ok":true}'))
            if url=='https://blackoutburst.com/internal/account/session': return 404,{},b''
            raise AssertionError('Unexpected fixed probe target')
        def sleep(seconds): sleeps.append(seconds); now[0]+=seconds
        with patch.object(INSTALL,'probe',probe),patch.object(INSTALL.time,'monotonic',lambda:now[0]),patch.object(INSTALL.time,'sleep',sleep):
            yield calls,sleeps,now

    def test_prior_public_404_waits_for_readiness_before_strict_denial_checks(self):
        with self.fixture(readiness=[(404,{},b'old configuration'),(200,{'cache-control':'no-store'},self.READY)]) as (calls,sleeps,_):
            checks=INSTALL.verify_routes()
        self.assertEqual(checks,{'local_anonymous':401,'public_anonymous':401,'account_health':200,'public_internal':404})
        self.assertEqual(sleeps,[0.25])
        urls=[call[0] for call in calls]
        public_post=urls.index(self.PUBLIC+'/api/session')
        self.assertEqual(urls[:public_post].count(self.PUBLIC+'/api/status'),2)
        self.assertTrue(all(0<call[4]<=5 for call in calls))

    def test_permanent_public_404_has_bounded_timeout_and_public_diagnostic(self):
        with self.fixture(readiness=[(404,{},b'{"private":"secret-marker"}')]) as (calls,_,now):
            with self.assertRaises(INSTALL.Refused) as caught: INSTALL.verify_routes()
        self.assertEqual(str(caught.exception),'PUBLIC_READINESS_TIMEOUT')
        self.assertEqual(caught.exception.diagnostic,{'leg':'public_readiness','status':404,'no_store':False,'error_code':None})
        self.assertEqual(now[0],15)
        self.assertNotIn(self.PUBLIC+'/api/session',[call[0] for call in calls])
        self.assertTrue(any(call[4]<5 for call in calls if call[0]==self.PUBLIC+'/api/status'))

    def test_public_readiness_rejects_malformed_wrong_mode_or_active_adapters_without_retry(self):
        variants=[b'not JSON',b'[]',b'{"service":{"mode":"demo"}}',
            self.READY.replace(b'account',b'unavailable'),self.READY.replace(b'unavailable',b'ready',1),
            self.READY.replace(b'unavailable',b'ready')]
        for data in variants:
            with self.subTest(data=data):
                with self.fixture(readiness=[(200,{'cache-control':'no-store'},data)]) as (calls,sleeps,_):
                    with self.assertRaises(INSTALL.Refused) as caught: INSTALL.verify_routes()
                self.assertEqual(str(caught.exception),'PUBLIC_READINESS_FAILED')
                self.assertEqual(caught.exception.diagnostic['leg'],'public_readiness')
                self.assertEqual([call[0] for call in calls].count(self.PUBLIC+'/api/status'),1)
                self.assertEqual(sleeps,[])

    def test_readiness_retries_only_404_and_still_requires_no_store(self):
        for result in [(302,{'location':'private-marker'},b''),(503,{},b'private-marker'),(200,{},self.READY)]:
            with self.subTest(status=result[0]):
                with patch.object(INSTALL,'probe',side_effect=lambda url,*a,**k:self.DENIED if url.endswith('/api/session') else result):
                    with patch.object(INSTALL.time,'sleep') as sleep:
                        with self.assertRaises(INSTALL.Refused) as caught: INSTALL.verify_routes()
                self.assertEqual(str(caught.exception),'PUBLIC_READINESS_FAILED'); sleep.assert_not_called()

    def test_anonymous_200_is_never_retried_locally_or_publicly(self):
        for leg in ['local_anonymous','public_anonymous']:
            with self.subTest(leg=leg):
                with patch.object(INSTALL,'probe') as probe, patch.object(INSTALL.time,'sleep') as sleep:
                    def response(url,method='GET',headers=None,body=None,**kwargs):
                        if url.endswith('/api/status'): return 200,{'cache-control':'no-store'},self.READY
                        label='public' if url.startswith(self.PUBLIC) else 'local'
                        current=label+('_invalid_cookie' if (headers or {}).get('Cookie') else '_anonymous')
                        return (200,{'cache-control':'no-store'},b'{"companionId":"private-marker"}') if current==leg else self.DENIED
                    probe.side_effect=response
                    with self.assertRaises(INSTALL.Refused) as caught: INSTALL.verify_routes()
                self.assertEqual(str(caught.exception),'ANONYMOUS_DENIAL_FAILED')
                self.assertEqual(caught.exception.diagnostic,{'leg':leg,'status':200,'no_store':True,'error_code':None})
                sleep.assert_not_called()
                self.assertNotIn('private-marker',json.dumps(caught.exception.diagnostic))

    def test_denial_diagnostics_distinguish_local_public_and_invalid_cookie(self):
        for leg in ['local_anonymous','local_invalid_cookie','public_anonymous','public_invalid_cookie']:
            with self.subTest(leg=leg):
                with self.fixture(overrides={leg:(403,{'cache-control':'no-store','private-header':'secret-marker'},
                        b'{"error":{"code":"ORIGIN_REJECTED","message":"secret-marker"},"userId":"secret-marker"}')}):
                    with self.assertRaises(INSTALL.Refused) as caught: INSTALL.verify_routes()
                self.assertEqual(caught.exception.diagnostic,{'leg':leg,'status':403,'no_store':True,'error_code':'ORIGIN_REJECTED'})
                self.assertNotIn('secret-marker',json.dumps(caught.exception.diagnostic))

    def test_every_denial_still_requires_exact_no_store_on_401(self):
        for leg in ['local_anonymous','local_invalid_cookie','public_anonymous','public_invalid_cookie']:
            with self.subTest(leg=leg),self.fixture(overrides={leg:(401,{},self.DENIED[2])}):
                with self.assertRaises(INSTALL.Refused) as caught: INSTALL.verify_routes()
                self.assertEqual(caught.exception.diagnostic,{'leg':leg,'status':401,'no_store':False,'error_code':'AUTHENTICATION_REQUIRED'})

    def test_probe_errors_and_unknown_error_codes_are_sanitized(self):
        with patch.object(INSTALL,'probe',side_effect=ValueError('private-transport-marker')):
            with self.assertRaises(INSTALL.Refused) as caught: INSTALL.verify_routes()
        self.assertEqual(str(caught.exception),'ROUTE_PROBE_FAILED')
        self.assertEqual(caught.exception.diagnostic,{'leg':'local_anonymous','status':None,'no_store':False,'error_code':None})
        diagnostic=INSTALL.route_diagnostic('local_anonymous',503,{'private':'marker'},b'{"error":{"code":"private-marker"}}')
        self.assertIsNone(diagnostic['error_code']); self.assertNotIn('marker',json.dumps(diagnostic))

    def test_account_health_uses_healthz_and_malformed_health_is_sanitized(self):
        with self.fixture(overrides={'account_health':(200,{},b'{"private":"secret-marker"}')}) as (calls,_,_):
            with self.assertRaises(INSTALL.Refused) as caught: INSTALL.verify_routes()
        self.assertEqual(str(caught.exception),'ACCOUNT_HEALTH_FAILED')
        self.assertEqual(caught.exception.diagnostic['leg'],'account_health')
        self.assertIn('http://127.0.0.1:9011/healthz',[call[0] for call in calls])
        self.assertNotIn('http://127.0.0.1:9011/health',[call[0] for call in calls])
        self.assertNotIn('secret-marker',json.dumps(caught.exception.diagnostic))

    def test_failure_diagnostic_survives_successful_rollback_wrapper(self):
        source=Path(INSTALL.__file__).read_text()
        main=next(node for node in ast.parse(source).body if isinstance(node,ast.FunctionDef) and node.name=='main')
        handler=next(node.handlers[0] for node in reversed(main.body) if isinstance(node,ast.Try))
        receipt={}
        diagnostic={'leg':'public_anonymous','status':404,'no_store':False,'error_code':None}
        def rollback(value): value['phase']='rolled_back'
        namespace={'receipt':receipt,'error':INSTALL.Refused('ANONYMOUS_DENIAL_FAILED',diagnostic),
            'Refused':INSTALL.Refused,'rollback':rollback,'save_receipt':lambda value:None}
        with self.assertRaises(INSTALL.Refused) as caught:
            exec(compile(ast.Module(body=handler.body,type_ignores=[]),'actual-installation-handler','exec'),namespace)
        self.assertEqual(caught.exception.diagnostic['failure_diagnostic'],diagnostic)
        self.assertEqual(caught.exception.diagnostic['recovery_phase'],'rolled_back')
        self.assertEqual(receipt['failure_diagnostic'],diagnostic)

if __name__=='__main__': unittest.main()
