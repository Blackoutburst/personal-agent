"""Synthetic transition checks; no real account data or privileged operation."""

import copy
import importlib.util
import json
import os
import stat
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import patch


HERE = Path(__file__).resolve().parent
# The installer is Linux-only; importing these inert stubs permits local Windows
# unit tests. No mocked system command is ever allowed to execute.
for name in ('fcntl', 'pwd'):
    if name not in sys.modules:
        try:
            __import__(name)
        except ImportError:
            sys.modules[name] = types.ModuleType(name)
SPEC = importlib.util.spec_from_file_location('prior_transition_installer', HERE / 'personal-agent-root-install-v3.template.py')
INSTALL = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(INSTALL)


class PriorRollbackTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix='prior-rollback-synthetic-')
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.paths = {name: self.root / value for name, value in {
            'PRIOR_STAGE': 'stage-v2', 'PRIOR_RECEIPT': 'journal/install-v2.json', 'PRIOR_BACKUP': 'journal/before-v2.conf',
            'TARGET': 'nginx/canonical-vhost', 'TARGET_SECTION': 'nginx/loaded-vhost',
            'INCLUDE': 'nginx/preview.locations', 'PILOT': 'pilot/private.json'}.items()}
        for path in self.paths.values():
            path.parent.mkdir(parents=True, exist_ok=True)
        self.paths['PRIOR_STAGE'].mkdir()
        self.uid = getattr(os, 'getuid', lambda: 0)()
        self.gid = getattr(os, 'getgid', lambda: 0)()
        self.original = b'original synthetic vhost\n'
        self.paths['TARGET'].write_bytes(self.original)
        self.paths['PRIOR_BACKUP'].write_bytes(self.original)
        self.paths['PILOT'].write_bytes(b'private-pilot-marker-never-read')
        self.dump = 'synthetic restored full nginx dump\n'
        sources = {f'synthetic/member-{index}': INSTALL.digest(str(index).encode()) for index in range(28)}
        self.manifest = {'schema_version': 3, 'commit': 'synthetic-version', 'release': '/synthetic/release',
            'archive_sha256': INSTALL.digest(b'archive'), 'source_sha256': sources,
            'unit_sha256': INSTALL.digest(b'unit'), 'proxy_sha256': INSTALL.digest(b'proxy'),
            'target_before_sha256': INSTALL.digest(self.original), 'target_section': str(self.paths['TARGET_SECTION']),
            'canonical_target': str(self.paths['TARGET']), 'reserved_include': str(self.paths['INCLUDE'])}
        prior_manifest = {**self.manifest, 'schema_version': 2}
        self.manifest_bytes = (json.dumps(prior_manifest, sort_keys=True) + '\n').encode()
        self.installer_bytes = b'# synthetic pinned prior installer; never executed\n'
        (self.paths['PRIOR_STAGE'] / 'operator-manifest.json').write_bytes(self.manifest_bytes)
        (self.paths['PRIOR_STAGE'] / 'install-account-preview-v2.py').write_bytes(self.installer_bytes)
        self.prior_target = {'resolved': str(self.paths['TARGET']), 'device': 7, 'inode': 11,
                             'sha256': INSTALL.digest(self.original)}
        self.other = str(self.root / 'nginx/private-source-marker')
        self.snapshot = {str(self.paths['TARGET_SECTION']): {**self.prior_target, 'inode': 22},
                         self.other: {'resolved': self.other, 'device': 7, 'inode': 33, 'sha256': INSTALL.digest(b'other')}}
        self.receipt = {'phase': 'rolled_back', 'failure_reason': 'ANONYMOUS_DENIAL_FAILED',
            'manifest_sha256': INSTALL.digest(self.manifest_bytes), 'receipt': str(self.paths['PRIOR_RECEIPT']),
            'commit': self.manifest['commit'], 'source_archive_sha256': self.manifest['archive_sha256'],
            'unit_sha256': self.manifest['unit_sha256'], 'proxy_sha256': self.manifest['proxy_sha256'],
            'target_before_sha256': self.manifest['target_before_sha256'], 'target_mode': 0o600, 'target_gid': self.gid,
            'target_section': str(self.paths['TARGET_SECTION']), 'canonical_target': str(self.paths['TARGET']),
            'private_pilot_validated': True, 'pilot_count': 2, 'shared_public_preserved': True,
            'boot_enabled': False, 'provider_runtime_activated': False, 'real_pilot_signin_accepted': False,
            'nginx_baseline_dump_sha256': INSTALL.digest(self.dump.encode()),
            '_private': {'baseline_snapshot': {**copy.deepcopy(self.snapshot), str(self.paths['TARGET_SECTION']): self.prior_target}}}
        self.write_receipt()
        self.metadata = {}
        for path in [self.paths['TARGET'], self.paths['PRIOR_RECEIPT'], self.paths['PRIOR_BACKUP']]:
            self.metadata[path] = {'st_uid': 0, 'st_mode': stat.S_IFREG | 0o600}
        self.metadata[self.paths['PILOT']] = {'st_uid': self.uid, 'st_mode': stat.S_IFREG | 0o600}
        self.metadata[self.paths['PILOT'].parent] = {'st_uid': self.uid, 'st_mode': stat.S_IFDIR | 0o700}
        self.metadata[self.paths['PRIOR_STAGE']] = {'st_uid': self.uid, 'st_mode': stat.S_IFDIR | 0o700}
        self.metadata[self.paths['PRIOR_RECEIPT'].parent] = {'st_uid': 0, 'st_mode': stat.S_IFDIR | 0o700}
        for name in ('operator-manifest.json', 'install-account-preview-v2.py'):
            self.metadata[self.paths['PRIOR_STAGE'] / name] = {'st_uid': self.uid, 'st_mode': stat.S_IFREG | 0o600}
        actual_lstat = Path.lstat
        def synthetic_lstat(path):
            info = actual_lstat(path)
            values = {name: getattr(info, name) for name in dir(info) if name.startswith('st_')}
            values.update(self.metadata.get(path, {}))
            return types.SimpleNamespace(**values)
        actual_read = INSTALL.read_file
        self.reads = []
        def read(path, *args, **kwargs):
            self.assertNotEqual(path, self.paths['PILOT'], 'The helper must not read pilot contents')
            self.reads.append(path)
            return actual_read(path, *args, **kwargs)
        self.state = {'LoadState': 'not-found', 'MainPID': '0', 'ControlPID': '0', 'ActiveState': 'inactive'}
        patches = [patch.multiple(INSTALL, **self.paths, create=True), patch('pathlib.Path.lstat', synthetic_lstat),
            patch.object(INSTALL.os, 'O_NOFOLLOW', getattr(os, 'O_NOFOLLOW', 0), create=True),
            patch.object(INSTALL, 'PRIOR_MANIFEST_SHA', INSTALL.digest(self.manifest_bytes), create=True),
            patch.object(INSTALL, 'PRIOR_INSTALLER_SHA', INSTALL.digest(self.installer_bytes), create=True),
            patch.object(INSTALL, 'pwd', types.SimpleNamespace(getpwnam=lambda name: types.SimpleNamespace(pw_uid=self.uid))),
            patch.object(INSTALL, 'check_ancestors', lambda path: None), patch.object(INSTALL, 'read_file', read),
            patch.object(INSTALL, 'show_properties', lambda *args: self.state),
            patch.object(INSTALL, 'verify_target_binding', lambda: {str(self.paths['TARGET_SECTION']): self.snapshot[str(self.paths['TARGET_SECTION'])]}),
            patch.object(INSTALL, 'run', side_effect=AssertionError('No command may run'))]
        for manager in patches:
            manager.start()
            self.addCleanup(manager.stop)

    def write_receipt(self):
        self.paths['PRIOR_RECEIPT'].write_text(json.dumps(self.receipt), encoding='utf-8')

    def validate(self, **overrides):
        return INSTALL.validate_prior_rollback(overrides.get('manifest', self.manifest),
            overrides.get('nginx_dump', self.dump), overrides.get('before_snapshot', self.snapshot))

    def refused(self, reason=None, **overrides):
        with self.assertRaises(INSTALL.Refused) as captured:
            self.validate(**overrides)
        if reason:
            self.assertEqual(str(captured.exception), reason)
        self.assertNotIn('private-', str(captured.exception))

    def test_clean_rollback_accepts_restored_inode_and_preserves_private_evidence(self):
        evidence = {path: path.read_bytes() for path in self.reads + [self.paths['PRIOR_RECEIPT'], self.paths['PRIOR_BACKUP']]}
        result = self.validate()
        self.assertTrue(result['preserved'])
        self.assertEqual(result['prior_backup_sha256'], INSTALL.digest(self.original))
        self.assertEqual(set(result), {'prior_version', 'prior_phase', 'prior_receipt_sha256', 'prior_manifest_sha256',
                                       'prior_installer_sha256', 'prior_backup_sha256', 'preserved'})
        self.assertTrue(all(type(value) in (str, int, bool) for value in result.values()))
        for private in ('private-', str(self.root), '_private', 'baseline_snapshot', 'principals'):
            self.assertNotIn(private, json.dumps(result))
        self.assertNotIn(self.paths['PILOT'], self.reads)
        self.assertEqual({path: path.read_bytes() for path in evidence}, evidence)

    def test_wrong_phases_failure_or_recovery_are_refused(self):
        for phase in ('verified', 'prepared', 'installing', 'recovery_required'):
            self.receipt['phase'] = phase; self.write_receipt(); self.refused('PRIOR_ATTEMPT_NOT_SUPPORTED')
        self.receipt['phase'] = 'rolled_back'; self.receipt['failure_reason'] = 'OTHER_FAILURE'; self.write_receipt()
        self.refused('PRIOR_ATTEMPT_NOT_SUPPORTED')
        self.receipt['failure_reason'] = 'ANONYMOUS_DENIAL_FAILED'; self.receipt['recovery_reason'] = 'private-marker'; self.write_receipt()
        self.refused('PRIOR_ATTEMPT_NOT_SUPPORTED')

    def test_manifest_installer_receipt_and_shared_release_identity_are_bound(self):
        for field in ('commit', 'release', 'archive_sha256', 'unit_sha256', 'proxy_sha256', 'target_before_sha256'):
            changed = {**self.manifest, field: 'private-marker'}
            self.refused('PRIOR_RELEASE_IDENTITY_DRIFT', manifest=changed)
        changed = copy.deepcopy(self.manifest); changed['source_sha256']['synthetic/member-0'] = 'drift'
        self.refused('PRIOR_SOURCE_IDENTITY_DRIFT', manifest=changed)
        self.receipt['manifest_sha256'] = 'drift'; self.write_receipt(); self.refused('PRIOR_RECEIPT_IDENTITY_DRIFT')
        self.receipt['manifest_sha256'] = INSTALL.digest(self.manifest_bytes); self.write_receipt()
        for name in ('operator-manifest.json', 'install-account-preview-v2.py'):
            path = self.paths['PRIOR_STAGE'] / name; original = path.read_bytes(); path.write_bytes(b'private-marker')
            self.refused('FILE_HASH_DRIFT'); path.write_bytes(original)

    def test_global_baseline_source_set_and_other_inode_drift_are_refused(self):
        self.refused('PRIOR_NGINX_BASELINE_DRIFT', nginx_dump=self.dump + '# private-marker')
        self.refused('PRIOR_SOURCE_SET_DRIFT', before_snapshot={str(self.paths['TARGET_SECTION']): self.snapshot[str(self.paths['TARGET_SECTION'])]})
        for field, value in (('sha256', 'drift'), ('inode', 999), ('resolved', '/private-marker')):
            changed = copy.deepcopy(self.snapshot); changed[self.other][field] = value
            self.refused('PRIOR_OTHER_SOURCE_DRIFT', before_snapshot=changed)
        changed = copy.deepcopy(self.snapshot); changed[str(self.paths['TARGET_SECTION'])]['device'] = 999
        self.refused('PRIOR_TARGET_SNAPSHOT_DRIFT', before_snapshot=changed)

    def test_target_binding_bytes_metadata_and_retained_backup_are_checked(self):
        with patch.object(INSTALL, 'verify_target_binding', return_value={}):
            self.refused('PRIOR_TARGET_BINDING_DRIFT')
        self.metadata[self.paths['TARGET']]['st_mode'] = stat.S_IFREG | 0o640
        self.refused('PRIOR_TARGET_METADATA_DRIFT')
        self.metadata[self.paths['TARGET']]['st_mode'] = stat.S_IFREG | 0o600
        self.paths['PRIOR_BACKUP'].write_bytes(b'private-marker'); self.refused('FILE_HASH_DRIFT')

    def test_active_process_or_missing_or_nonprivate_pilot_is_refused_without_reading_it(self):
        for field, value in (('MainPID', '123'), ('ControlPID', '123'), ('ActiveState', 'active')):
            original = self.state[field]; self.state[field] = value; self.refused('PRIOR_SERVICE_STILL_ACTIVE'); self.state[field] = original
        self.paths['PILOT'].unlink(); self.refused('PRIOR_PRIVATE_PILOT_REQUIRED')
        self.paths['PILOT'].write_bytes(b'private-marker')
        for field, value in (('st_mode', stat.S_IFREG | 0o644), ('st_uid', self.uid + 1), ('st_nlink', 2)):
            original = self.metadata[self.paths['PILOT']].get(field)
            self.metadata[self.paths['PILOT']][field] = value; self.refused('PRIOR_PRIVATE_PILOT_METADATA_INVALID')
            if original is None: self.metadata[self.paths['PILOT']].pop(field)
            else: self.metadata[self.paths['PILOT']][field] = original
        self.assertNotIn(self.paths['PILOT'], self.reads)


if __name__ == '__main__':
    unittest.main()
