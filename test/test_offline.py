"""全部测试只触碰本项目 test 下的临时数据，进程检测均注入。"""
import contextlib
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import offline

ID = 'session-12345678-1234-1234-1234-123456789abc'
OTHER = '87654321-4321-4321-4321-cba987654321'


class OfflineTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix='offline-', dir=Path(__file__).parent)
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name).absolute()
        self.project = self.base / 'project'
        self.project.mkdir()
        (self.project / 'valuable.py').write_text('项目代码必须保留', encoding='utf-8')
        self.sessions = self.base / 'sessions'
        self.directory = self.sessions / 'project-key' / ID
        self.directory.mkdir(parents=True)
        (self.directory / 'conversation.json').write_text('{"text":"会话"}', encoding='utf-8')
        (self.directory / 'session.lock').write_bytes('旧锁内容'.encode())
        (self.directory / 'nested').mkdir()
        (self.directory / 'nested' / 'events.jsonl').write_bytes(b'{}\n')
        self.storage = self.base / 'storage'
        self.storage.mkdir()
        (self.storage / 'attachments').mkdir()
        (self.storage / 'attachments' / 'shared').write_bytes('共享附件'.encode())
        self.workspace = self.storage / 'workspace.json'
        self.doc = {'unit': {'name': 'workspace', 'version': 2}, 'global': {'workspaceIds': ['w'], 'archivedSessionIds': [ID, OTHER], 'pinnedSessionIds': [ID]}, 'tables': {'workspaces': {'w': {'sessionIds': [ID, OTHER], 'name': '项目'}}}}
        self.workspace.write_bytes(offline.encoded(self.doc))
        self.cache = self.storage / 'session_projcache' / 'sessions'
        self.cache.mkdir(parents=True)
        (self.cache / (ID + '.json')).write_bytes(b'{"sessionId":"target"}')
        (self.cache / (OTHER + '.json')).write_bytes(b'{"sessionId":"other"}')
        self.legacy = self.storage / 'session_projcache.json'
        self.legacy_doc = {'unit': {'name': 'session_projcache', 'version': 7}, 'tables': {'sessions': {ID: {'text': '删除'}, OTHER: {'text': '保留'}}}, 'extra': 1}
        self.legacy.write_bytes(offline.encoded(self.legacy_doc))
        self.manifest = self.base / 'manifest.json'
        self.m = {'version': 1, 'token': 'test-token', 'createdAt': '2026-11-10T08:00:00Z', 'roots': {'sessions': str(self.sessions), 'storage': str(self.storage)}, 'targets': [{'id': ID, 'dir': str(self.directory), 'files': offline.snapshot(self.directory)}], 'workspace': {'path': str(self.workspace), 'sha256': offline.digest(self.workspace.read_bytes())}, 'protectedPaths': [str(self.project)]}
        self.save()
        self.backup = self.base / 'backup-test-token'

    def save(self):
        self.manifest.write_bytes(offline.encoded(self.m))

    def run_tool(self, *args, check=lambda: []):
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            return offline.main([str(self.manifest), *args], process_check_fn=check)

    def apply(self):
        return self.run_tool('--apply', '--confirm', 'test-token')

    def restore(self):
        return self.run_tool('--restore', '--confirm', 'test-token')

    def test_dry_run_unchanged(self):
        before = {str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        self.assertEqual(self.run_tool(), 0)
        after = {str(p.relative_to(self.base)): p.read_bytes() for p in self.base.rglob('*') if p.is_file()}
        self.assertEqual(before, after)
        self.assertFalse(self.backup.exists())

    def test_apply_preserves_project_and_shared_data(self):
        self.assertEqual(self.apply(), 0)
        self.assertFalse(self.directory.exists())
        self.assertEqual((self.project / 'valuable.py').read_text(), '项目代码必须保留')
        self.assertEqual((self.storage / 'attachments' / 'shared').read_bytes(), '共享附件'.encode())
        cleaned = json.loads(self.workspace.read_bytes())
        self.assertEqual(cleaned['global']['archivedSessionIds'], [OTHER])
        self.assertEqual(cleaned['global']['pinnedSessionIds'], [])
        self.assertEqual(cleaned['global']['workspaceIds'], ['w'])
        self.assertEqual(cleaned['tables']['workspaces']['w']['sessionIds'], [OTHER])
        self.assertEqual(cleaned['tables']['workspaces']['w']['name'], '项目')
        self.assertFalse((self.cache / (ID + '.json')).exists())
        self.assertTrue((self.cache / (OTHER + '.json')).exists())
        self.assertEqual(json.loads(self.legacy.read_bytes())['tables']['sessions'], {OTHER: {'text': '保留'}})
        receipt = json.loads((self.backup / 'receipt.json').read_bytes())
        self.assertEqual(receipt['status'], 'applied')
        self.assertTrue(receipt['journal'])

    def test_backup_and_restore(self):
        before_workspace = self.workspace.read_bytes()
        before_legacy = self.legacy.read_bytes()
        before_session = offline.snapshot(self.directory)
        self.assertEqual(self.apply(), 0)
        self.assertEqual(self.restore(), 0)
        self.assertEqual(self.workspace.read_bytes(), before_workspace)
        self.assertEqual(self.legacy.read_bytes(), before_legacy)
        self.assertEqual(offline.snapshot(self.directory), before_session)
        self.assertTrue((self.directory / 'session.lock').exists())
        self.assertTrue((self.cache / (ID + '.json')).exists())
        self.assertTrue(self.backup.exists())

    def test_bare_uuid_supported(self):
        bare = ID.removeprefix('session-')
        renamed = self.directory.with_name(bare)
        self.directory.rename(renamed)
        self.m['targets'][0].update(id=bare, dir=str(renamed))
        self.save()
        self.assertEqual(self.apply(), 0)
        self.assertFalse(renamed.exists())

    def test_corrupt_cache_backups_removed_and_restored(self):
        backup = self.cache / (ID + '.json.bak.20261110')
        other = self.cache / (OTHER + '.json.bak.20261110')
        backup.write_bytes(b'corrupt cache')
        other.write_bytes(b'other cache')
        self.assertEqual(self.apply(), 0)
        self.assertFalse(backup.exists())
        self.assertTrue(other.exists())
        self.assertEqual(self.restore(), 0)
        self.assertEqual(backup.read_bytes(), b'corrupt cache')

    def test_apply_requires_confirm(self):
        self.assertEqual(self.run_tool('--apply'), 1)
        self.assertEqual(self.run_tool('--apply', '--confirm', 'bad'), 1)
        self.assertTrue(self.directory.exists())

    def test_busy_refused(self):
        self.assertEqual(self.run_tool('--apply', '--confirm', 'test-token', check=lambda: ['dsh web']), 1)
        self.assertTrue(self.directory.exists())
        self.assertFalse(self.backup.exists())

    def test_busy_rechecked_before_mutation(self):
        checks = iter([[], [], ['dsh web']])
        before = self.workspace.read_bytes()
        self.assertEqual(self.run_tool('--apply', '--confirm', 'test-token', check=lambda: next(checks)), 1)
        self.assertTrue(self.directory.exists())
        self.assertEqual(self.workspace.read_bytes(), before)

    def test_process_filter(self):
        output = '90 /usr/local/bin/node unrelated.js\n91 ps ax\n92 python -m unittest test.test_offline\n93 /opt/bin/dsh web\n94 /Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness\n95 node /opt/dsh/dist/host.js\n'
        with mock.patch.object(offline.subprocess, 'run', return_value=mock.Mock(stdout=output)):
            found = offline.process_check()
        self.assertEqual(len(found), 3)

    def test_symlink_file_rejected(self):
        (self.directory / 'link').symlink_to(self.project / 'valuable.py')
        self.assertEqual(self.apply(), 1)
        self.assertTrue((self.project / 'valuable.py').exists())

    def test_symlink_parent_rejected(self):
        alias = self.base / 'alias'
        alias.symlink_to(self.sessions, target_is_directory=True)
        self.m['roots']['sessions'] = str(alias)
        self.m['targets'][0]['dir'] = str(alias / 'project-key' / ID)
        self.save()
        self.assertEqual(self.apply(), 1)

    def test_symlink_lock_rejected(self):
        (self.directory / 'session.lock').unlink()
        (self.directory / 'session.lock').symlink_to(self.project / 'valuable.py')
        self.assertEqual(self.apply(), 1)

    def test_escape_rejected(self):
        self.m['targets'][0]['dir'] = str(self.sessions / '..' / 'project' / ID)
        self.save()
        self.assertEqual(self.apply(), 1)

    def test_uuid_and_depth(self):
        self.m['targets'][0]['id'] = '../project'
        self.save()
        self.assertEqual(self.apply(), 1)
        self.m['targets'][0]['id'] = ID
        self.m['targets'][0]['dir'] = str(self.sessions / ID)
        self.save()
        self.assertEqual(self.apply(), 1)

    def test_snapshot_drift(self):
        (self.directory / 'conversation.json').write_bytes(b'changed')
        self.assertEqual(self.apply(), 1)
        self.assertFalse(self.backup.exists())

    def test_new_file_rejected(self):
        (self.directory / 'new').write_bytes(b'new')
        self.assertEqual(self.apply(), 1)

    def test_lock_contents_ignored(self):
        (self.directory / 'session.lock').write_bytes('锁内容改变'.encode())
        self.assertEqual(self.apply(), 0)

    def test_protected_overlap_both_directions(self):
        for protected in (self.directory, self.directory / 'nested', self.directory.parent):
            self.m['protectedPaths'] = [str(protected)]
            self.save()
            self.assertEqual(self.apply(), 1)

    def test_workspace_path_rejected(self):
        self.m['workspace']['path'] = str(self.project / 'valuable.py')
        self.save()
        self.assertEqual(self.apply(), 1)

    def test_workspace_pending_rejected(self):
        self.doc['global']['pendingMutation'] = {}
        self.workspace.write_bytes(offline.encoded(self.doc))
        self.m['workspace']['sha256'] = offline.digest(self.workspace.read_bytes())
        self.save()
        self.assertEqual(self.apply(), 1)

    def test_restore_refuses_new_work(self):
        self.assertEqual(self.apply(), 0)
        self.workspace.write_bytes(b'{"new":"work"}')
        self.assertEqual(self.restore(), 1)
        self.assertEqual(self.workspace.read_bytes(), b'{"new":"work"}')
        self.assertFalse(self.directory.exists())

    def test_restore_refuses_existing_target(self):
        self.assertEqual(self.apply(), 0)
        self.directory.mkdir()
        (self.directory / 'new').write_bytes(b'new work')
        self.assertEqual(self.restore(), 1)
        self.assertEqual((self.directory / 'new').read_bytes(), b'new work')

    def test_backup_drift_rejected(self):
        self.assertEqual(self.apply(), 0)
        (self.backup / 'session-0' / 'conversation.json').write_bytes(b'corrupt')
        self.assertEqual(self.restore(), 1)
        self.assertEqual(self.run_tool('--purge-backup', '--confirm', 'test-token'), 1)

    def test_purge_refuses_unknown_backup_file(self):
        self.assertEqual(self.apply(), 0)
        (self.backup / 'unexpected-project.py').write_text('新文件')
        self.assertEqual(self.run_tool('--purge-backup', '--confirm', 'test-token'), 1)
        self.assertTrue((self.backup / 'unexpected-project.py').exists())

    def test_lock_busy(self):
        with offline.locks(self.m):
            self.assertEqual(self.apply(), 1)
        self.assertTrue(self.directory.exists())

    def test_restore_racing_target_is_preserved(self):
        self.assertEqual(self.apply(), 0)
        original = Path.mkdir
        def race(path, *args, **kwargs):
            if path == self.directory:
                original(path)
                (path / 'new-project.py').write_text('竞争创建的新文件')
                raise FileExistsError('目标刚刚由其他进程创建')
            return original(path, *args, **kwargs)
        with mock.patch.object(Path, 'mkdir', race):
            self.assertEqual(self.restore(), 1)
        self.assertEqual((self.directory / 'new-project.py').read_text(), '竞争创建的新文件')

    def test_purge_requires_explicit_confirm(self):
        self.assertEqual(self.apply(), 0)
        self.assertEqual(self.run_tool('--purge-backup'), 1)
        self.assertTrue(self.backup.exists())
        self.assertEqual(self.run_tool('--purge-backup', '--confirm', 'test-token'), 0)
        self.assertFalse(self.backup.exists())

    def test_metadata_failure_rolls_back(self):
        before = self.workspace.read_bytes()
        original = offline.atomic
        failed = False
        def fail_once(path, data):
            nonlocal failed
            if path == self.legacy and not failed:
                failed = True
                raise OSError('注入写入失败')
            return original(path, data)
        with mock.patch.object(offline, 'atomic', side_effect=fail_once):
            self.assertEqual(self.apply(), 1)
        self.assertEqual(self.workspace.read_bytes(), before)
        self.assertTrue(self.directory.exists())
        self.assertTrue((self.cache / (ID + '.json')).exists())
        self.assertEqual(json.loads((self.backup / 'receipt.json').read_bytes())['status'], 'rolled_back')

    def test_partial_delete_failure_rolls_back(self):
        before = offline.snapshot(self.directory)
        original = offline.shutil.rmtree
        failed = False
        def fail_once(path, *args, **kwargs):
            nonlocal failed
            if Path(path) == self.directory and not failed:
                failed = True
                (self.directory / 'conversation.json').unlink()
                raise OSError('注入删除失败')
            return original(path, *args, **kwargs)
        with mock.patch.object(offline.shutil, 'rmtree', side_effect=fail_once):
            self.assertEqual(self.apply(), 1)
        self.assertEqual(offline.snapshot(self.directory), before)
        self.assertEqual(json.loads(self.workspace.read_bytes()), self.doc)

    def test_restore_failure_rolls_back_restore(self):
        self.assertEqual(self.apply(), 0)
        cleaned = self.workspace.read_bytes()
        original = offline.atomic
        failed = False
        def fail_once(path, data):
            nonlocal failed
            if path == self.legacy and not failed:
                failed = True
                raise OSError('注入恢复失败')
            return original(path, data)
        with mock.patch.object(offline, 'atomic', side_effect=fail_once):
            self.assertEqual(self.restore(), 1)
        self.assertFalse(self.directory.exists())
        self.assertEqual(self.workspace.read_bytes(), cleaned)
        self.assertEqual(self.restore(), 0)


if __name__ == '__main__':
    unittest.main()
