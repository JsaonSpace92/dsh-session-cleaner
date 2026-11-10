#!/usr/bin/env python3
"""macOS/Linux 离线会话维护器；默认只验证，不修改 DSH 数据。"""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import stat
import subprocess
import sys
from contextlib import contextmanager

SESSION_ID = re.compile(r"[A-Za-z0-9][A-Za-z0-9_-]{0,127}\Z")
TOKEN = re.compile(r"[A-Za-z0-9_-]{1,100}\Z")
SHA = re.compile(r"[0-9a-f]{64}\Z")


class SafetyError(RuntimeError):
    pass


def require(ok, message):
    if not ok:
        raise SafetyError(message)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def absolute(value):
    require(isinstance(value, str) and os.path.isabs(value), '路径必须绝对')
    require(os.path.normpath(value) == value, '路径必须规范化且无逃逸')
    return Path(value)


def no_links(path, missing=False):
    for part in reversed((path, *path.parents)):
        try:
            mode = part.lstat().st_mode
        except FileNotFoundError:
            require(missing, '路径不存在：' + str(part))
            continue
        require(not stat.S_ISLNK(mode), '拒绝符号链接：' + str(part))


def read_bytes(path):
    no_links(path)
    with os.fdopen(os.open(path, os.O_RDONLY | os.O_NOFOLLOW), 'rb') as stream:
        require(stat.S_ISREG(os.fstat(stream.fileno()).st_mode), '必须为普通文件')
        return stream.read()


def load_json(path):
    def unique(pairs):
        result = {}
        for key, value in pairs:
            require(key not in result, 'JSON 存在重复键')
            result[key] = value
        return result
    return json.loads(read_bytes(path), object_pairs_hook=unique)


def fsync_dir(path):
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic(path, data):
    no_links(path, missing=True)
    tmp = path.with_name(path.name + '.offline-new')
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    try:
        with os.fdopen(fd, 'wb') as stream:
            stream.write(data)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(tmp, path)
        fsync_dir(path.parent)
    finally:
        if tmp.exists():
            tmp.unlink()


def encoded(value):
    return json.dumps(value, ensure_ascii=False, sort_keys=True, indent=2).encode() + b'\n'


def snapshot(directory):
    no_links(directory)
    require(directory.is_dir(), '目标不是目录')
    result = []
    for root, dirs, files in os.walk(directory, followlinks=False):
        for name in dirs + files:
            path = Path(root) / name
            mode = path.lstat().st_mode
            require(stat.S_ISREG(mode) or stat.S_ISDIR(mode), '拒绝链接或特殊文件：' + str(path))
        for name in files:
            path = Path(root) / name
            relative = path.relative_to(directory).as_posix()
            if relative == 'session.lock':
                continue
            data = read_bytes(path)
            result.append({'path': relative, 'size': len(data), 'sha256': digest(data)})
    return sorted(result, key=lambda item: item['path'])


def process_check():
    """返回实际 Host/CLI 进程；不把通用 node 或测试进程视为 Host。"""
    result = subprocess.run(['ps', 'ax', '-o', 'pid=,command='], check=True, capture_output=True, text=True)
    busy = []
    for line in result.stdout.splitlines():
        fields = line.strip().split(None, 1)
        if len(fields) != 2 or not fields[0].isdigit():
            continue
        pid, command = int(fields[0]), fields[1]
        if pid == os.getpid() or re.search(r'(?:^|[/\s])(ps|pytest|unittest)(?:\s|$)', command) or 'test_offline' in command:
            continue
        if ('DeepSeek Harness.app/' in command or
                re.search(r'(?:^|\s)(?:\S*/)?dsh(?:\s|$)', command) or
                re.search(r'(?:^|\s)\S*/dsh/(?:dist|bin)/(?:cli|host|index)\.(?:[cm]?js)(?:\s|$)', command)):
            busy.append(command)
    return busy


def offline(check):
    require(not check(), '检测到 DSH Host/CLI 在线；请关闭全部共享这些 roots 的 Host 后重试')


def validate(manifest_path, state=True):
    manifest_path = absolute(str(manifest_path))
    m = load_json(manifest_path)
    require(m.get('version') == 1 and TOKEN.fullmatch(m.get('token', '')), 'manifest 版本或 token 无效')
    require(isinstance(m.get('createdAt'), str) and m['createdAt'], '缺少 createdAt')
    sessions = absolute(m['roots']['sessions'])
    storage = absolute(m['roots']['storage'])
    no_links(sessions)
    no_links(storage)
    require(sessions.is_dir() and storage.is_dir(), 'roots 必须为目录')
    workspace = absolute(m['workspace']['path'])
    require(workspace == storage / 'workspace.json', 'workspace 路径无效')
    require(SHA.fullmatch(m['workspace']['sha256']) is not None, 'workspace 摘要无效')
    protected = m.get('protectedPaths')
    require(isinstance(protected, list) and protected, '必须指定项目保护路径')
    protected = [absolute(value) for value in protected]
    for path in protected:
        no_links(path, missing=True)
    targets = m.get('targets')
    require(isinstance(targets, list) and targets, 'targets 不能为空')
    seen = set()
    for target in targets:
        ident = target['id']
        require(isinstance(ident, str) and SESSION_ID.fullmatch(ident) is not None and ident not in seen, '会话 ID 无效或重复')
        seen.add(ident)
        directory = absolute(target['dir'])
        require(directory.parent.parent == sessions and directory.name == ident, '目标必须为 sessions/<project>/<会话 ID>')
        for path in protected:
            require(not (path == directory or path.is_relative_to(directory) or directory.is_relative_to(path)), '删除目录与保护路径重叠')
        for path in (storage, manifest_path.parent):
            require(not (path == directory or path.is_relative_to(directory)), 'metadata 或备份位于删除目录内')
        expected = target['files']
        require(isinstance(expected, list), 'files 必须为列表')
        names = set()
        for item in expected:
            rel = item['path']
            require(isinstance(rel, str) and rel and not rel.startswith('/') and '..' not in Path(rel).parts and str(Path(rel)) == rel, 'snapshot 路径逃逸')
            require(rel not in names and isinstance(item['size'], int) and item['size'] >= 0 and SHA.fullmatch(item['sha256']), 'snapshot 记录无效')
            names.add(rel)
        no_links(directory, missing=not state)
        if state:
            require(snapshot(directory) == sorted([i for i in expected if i['path'] != 'session.lock'], key=lambda i: i['path']), '会话 snapshot 漂移：' + str(directory))
    if not state:
        return m, None
    original = read_bytes(workspace)
    require(digest(original) == m['workspace']['sha256'], 'workspace snapshot 漂移')
    doc = load_json(workspace)
    require(doc.get('unit') == {'name': 'workspace', 'version': 2}, 'workspace 格式无效')
    require(isinstance(doc.get('global'), dict) and 'pendingMutation' not in doc['global'], 'workspace 存在 pendingMutation')
    require(isinstance(doc.get('tables', {}).get('workspaces'), dict), 'workspace 表无效')
    for key in ('workspaceIds', 'archivedSessionIds', 'pinnedSessionIds'):
        require(isinstance(doc['global'].get(key), list), 'workspace global 列表无效')
    for row in doc['tables']['workspaces'].values():
        require(isinstance(row, dict) and isinstance(row.get('sessionIds'), list), 'workspace 会话列表无效')
    return m, doc


def clean_workspace(doc, ids):
    result = copy.deepcopy(doc)
    for key in ('archivedSessionIds', 'pinnedSessionIds'):
        result['global'][key] = [value for value in result['global'][key] if value not in ids]
    for row in result['tables']['workspaces'].values():
        row['sessionIds'] = [value for value in row['sessionIds'] if value not in ids]
    return encoded(result)


def clean_legacy(path, ids):
    doc = load_json(path)
    require(doc.get('unit') == {'name': 'session_projcache', 'version': 7}, 'legacy 投影版本无效')
    require(isinstance(doc.get('tables', {}).get('sessions'), dict), 'legacy sessions 表无效')
    for ident in ids:
        doc['tables']['sessions'].pop(ident, None)
    return encoded(doc)


@contextmanager
def locks(m):
    descriptors = []
    try:
        for target in sorted(m['targets'], key=lambda t: t['dir']):
            path = Path(target['dir']) / 'session.lock'
            no_links(path, missing=True)
            fd = os.open(path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            descriptors.append(fd)
            require(stat.S_ISREG(os.fstat(fd).st_mode), '锁不是普通文件')
            try:
                fcntl.flock(fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError as error:
                raise SafetyError('会话锁忙') from error
        yield
    finally:
        for fd in descriptors:
            os.close(fd)


def backup_root(manifest, m):
    return manifest.parent / ('backup-' + m['token'])


def journal(root, receipt, event):
    receipt['journal'].append(event)
    atomic(root / 'receipt.json', encoded(receipt))


def verify_backup(root, receipt):
    no_links(root)
    require(root.name == 'backup-' + receipt['token'], '备份目录身份无效')
    if 'backupFiles' in receipt:
        actual = [item for item in snapshot(root) if item['path'] != 'receipt.json']
        require(actual == receipt['backupFiles'], '备份出现未知文件或内容漂移')
        directories = sorted(str(Path(base).relative_to(root)) for base, _, _ in os.walk(root) if Path(base) != root)
        require(directories == receipt['backupDirectories'], '备份目录结构漂移')
    for entry in receipt['targets']:
        require(snapshot(root / entry['backup']) == entry['files'], '会话备份校验失败')
    for entry in receipt['metadata']:
        if entry['before'] is not None:
            require(digest(read_bytes(root / entry['backup'])) == entry['before'], 'metadata 备份校验失败')


def rollback(root, receipt):
    verify_backup(root, receipt)
    for entry in receipt['targets']:
        target = Path(entry['path'])
        if entry['path'] in receipt['changed']:
            no_links(target, missing=True)
            if target.exists():
                shutil.rmtree(target)
            shutil.copytree(root / entry['backup'], target)
            fsync_dir(target.parent)
    for entry in receipt['metadata']:
        if entry['path'] not in receipt['changed']:
            continue
        path = Path(entry['path'])
        if entry['before'] is None:
            no_links(path, missing=True)
            if path.exists():
                path.unlink()
                fsync_dir(path.parent)
        else:
            atomic(path, read_bytes(root / entry['backup']))
    receipt['status'] = 'rolled_back'
    journal(root, receipt, '回滚完成')


def apply(manifest, m, doc, check):
    offline(check)
    root = backup_root(manifest, m)
    require(not root.exists(), '备份目录已存在，请检查 receipt')
    with locks(m):
        checked, doc = validate(manifest)
        require(checked == m, '加锁期间 manifest 发生变化')
        offline(check)
        root.mkdir(mode=0o700)
        receipt = {'version': 1, 'token': m['token'], 'manifestSha256': digest(read_bytes(manifest)), 'status': 'preparing', 'targets': [], 'metadata': [], 'changed': [], 'journal': []}
        journal(root, receipt, '开始准备完整备份')
        changes = [(Path(m['workspace']['path']), clean_workspace(doc, {t['id'] for t in m['targets']}))]
        storage = Path(m['roots']['storage'])
        cache = storage / 'session_projcache' / 'sessions'
        no_links(cache, missing=True)
        for target in m['targets']:
            paths = [cache / (target['id'] + '.json')]
            if cache.exists():
                paths.extend(cache.glob(target['id'] + '.json.bak.*'))
            for path in paths:
                no_links(path, missing=True)
                if path.exists():
                    read_bytes(path)
                    changes.append((path, None))
        legacy = storage / 'session_projcache.json'
        no_links(legacy, missing=True)
        if legacy.exists():
            changes.append((legacy, clean_legacy(legacy, {t['id'] for t in m['targets']})))
        for index, target in enumerate(m['targets']):
            dest = 'session-' + str(index)
            shutil.copytree(target['dir'], root / dest)
            files = snapshot(root / dest)
            require(files == snapshot(Path(target['dir'])), '复制期间会话发生变化')
            receipt['targets'].append({'path': target['dir'], 'backup': dest, 'files': files})
            journal(root, receipt, '已复制会话备份：' + target['dir'])
        for index, (path, data) in enumerate(changes):
            before = read_bytes(path) if path.exists() else None
            dest = 'metadata-' + str(index)
            if before is not None:
                atomic(root / dest, before)
            receipt['metadata'].append({'path': str(path), 'backup': dest, 'before': digest(before) if before is not None else None, 'after': digest(data) if data is not None else None})
            journal(root, receipt, '已备份 metadata：' + str(path))
        # 会话数据也持久化，才允许进入删除阶段。
        for base, dirs, files in os.walk(root):
            for name in files:
                fd = os.open(Path(base) / name, os.O_RDONLY | os.O_NOFOLLOW)
                try:
                    os.fsync(fd)
                finally:
                    os.close(fd)
            fsync_dir(Path(base))
        fsync_dir(root.parent)
        receipt['backupFiles'] = [item for item in snapshot(root) if item['path'] != 'receipt.json']
        receipt['backupDirectories'] = sorted(str(Path(base).relative_to(root)) for base, _, _ in os.walk(root) if Path(base) != root)
        verify_backup(root, receipt)
        journal(root, receipt, '备份已校验并持久化')
        try:
            checked, _ = validate(manifest)
            require(checked == m and digest(read_bytes(manifest)) == receipt['manifestSha256'], '执行前 manifest 发生变化')
            offline(check)
            receipt['status'] = 'applying'
            journal(root, receipt, '执行前复核完成')
            for (path, data), entry in zip(changes, receipt['metadata']):
                require(digest(read_bytes(path)) == entry['before'], 'metadata 执行前漂移')
                receipt['changed'].append(str(path))
                journal(root, receipt, '准备修改：' + str(path))
                if data is None:
                    path.unlink()
                    fsync_dir(path.parent)
                else:
                    atomic(path, data)
                journal(root, receipt, '已修改：' + str(path))
            for entry in receipt['targets']:
                path = Path(entry['path'])
                require(snapshot(path) == entry['files'], '删除前 snapshot 漂移')
                receipt['changed'].append(str(path))
                journal(root, receipt, '准备删除：' + str(path))
                shutil.rmtree(path)
                fsync_dir(path.parent)
                journal(root, receipt, '已删除：' + str(path))
            receipt['status'] = 'applied'
            journal(root, receipt, '清理成功；备份长期保留')
        except BaseException:
            rollback(root, receipt)
            raise
    return root


def saved_receipt(manifest, m):
    checked, _ = validate(manifest, state=False)
    require(checked == m, 'manifest 在确认后发生变化')
    root = backup_root(manifest, m)
    receipt = load_json(root / 'receipt.json')
    require(receipt.get('version') == 1 and receipt.get('token') == m['token'] and receipt.get('manifestSha256') == digest(read_bytes(manifest)), 'receipt 身份不匹配')
    require(receipt.get('status') in ('applied', 'restored'), 'receipt 未表明成功')
    require('backupFiles' in receipt and 'backupDirectories' in receipt, 'receipt 缺少完整备份清单')
    require([e['path'] for e in receipt['targets']] == [t['dir'] for t in m['targets']], 'receipt 目标不匹配')
    allowed = {m['workspace']['path'], str(Path(m['roots']['storage']) / 'session_projcache.json')}
    cache = Path(m['roots']['storage']) / 'session_projcache' / 'sessions'
    for entry in receipt['metadata']:
        path = absolute(entry['path'])
        is_cache = path.parent == cache and any(path.name == t['id'] + '.json' or path.name.startswith(t['id'] + '.json.bak.') for t in m['targets'])
        require((entry['path'] in allowed or is_cache) and re.fullmatch(r'metadata-[0-9]+', entry['backup']), 'receipt metadata 路径无效')
    for entry, target in zip(receipt['targets'], m['targets']):
        require(re.fullmatch(r'session-[0-9]+', entry['backup']), 'receipt 备份路径无效')
        require(entry['files'] == sorted([f for f in target['files'] if f['path'] != 'session.lock'], key=lambda f: f['path']), 'receipt 快照不匹配')
    verify_backup(root, receipt)
    return root, receipt


def restore(manifest, m, check):
    offline(check)
    root, receipt = saved_receipt(manifest, m)
    require(receipt['status'] == 'applied', '备份已经恢复')
    for entry in receipt['targets']:
        path = Path(entry['path'])
        no_links(path, missing=True)
        require(not path.exists(), '恢复目标已存在')
    for entry in receipt['metadata']:
        path = Path(entry['path'])
        no_links(path, missing=True)
        current = digest(read_bytes(path)) if path.exists() else None
        require(current == entry['after'], '清理后 metadata 已改变，拒绝覆盖新工作')
    offline(check)
    restored = []
    reverted = []
    clean_data = {entry['path']: (read_bytes(Path(entry['path'])) if Path(entry['path']).exists() else None) for entry in receipt['metadata']}
    try:
        for entry in receipt['targets']:
            path = Path(entry['path'])
            require(not path.exists(), '恢复目标已存在')
            path.mkdir()
            restored.append(path)
            shutil.copytree(root / entry['backup'], path, dirs_exist_ok=True)
            require(snapshot(path) == entry['files'], '恢复副本校验失败')
            fsync_dir(path.parent)
            journal(root, receipt, '已恢复会话：' + str(path))
        for entry in receipt['metadata']:
            path = Path(entry['path'])
            if entry['before'] is not None:
                reverted.append(path)
                atomic(path, read_bytes(root / entry['backup']))
                journal(root, receipt, '已恢复 metadata：' + str(path))
        receipt['status'] = 'restored'
        journal(root, receipt, '恢复成功')
    except BaseException:
        for path in reversed(reverted):
            data = clean_data[str(path)]
            if data is None:
                if path.exists():
                    path.unlink()
                    fsync_dir(path.parent)
            else:
                atomic(path, data)
        for path in reversed(restored):
            no_links(path, missing=True)
            if path.exists():
                shutil.rmtree(path)
                fsync_dir(path.parent)
        receipt['status'] = 'applied'
        journal(root, receipt, '恢复失败，已回滚恢复操作；备份保留')
        raise
    return root


def main(argv=None, process_check_fn=None):
    parser = argparse.ArgumentParser(description='关闭全部共享 roots 的 Host 后运行；共享 attachments 和项目目录始终保留。')
    parser.add_argument('manifest', type=Path)
    group = parser.add_mutually_exclusive_group()
    group.add_argument('--apply', action='store_true')
    group.add_argument('--restore', action='store_true')
    group.add_argument('--purge-backup', action='store_true')
    parser.add_argument('--confirm')
    args = parser.parse_args(argv)
    check = process_check_fn or process_check
    manifest = Path(os.path.abspath(args.manifest))
    try:
        m = load_json(manifest)
        require(TOKEN.fullmatch(m.get('token', '')) is not None, 'token 无效')
        if args.apply or args.restore or args.purge_backup:
            require(args.confirm == m['token'], '执行需要 --confirm <manifest.token>')
        if args.restore or args.purge_backup:
            # 原会话可能已经删除，恢复以成功 receipt 的绑定快照为依据。
            if args.restore:
                root = restore(manifest, m, check)
                print('恢复完成：' + str(root))
            else:
                offline(check)
                root, receipt = saved_receipt(manifest, m)
                offline(check)
                shutil.rmtree(root)
                fsync_dir(root.parent)
                print('已显式清除验证过的备份：' + str(root))
        else:
            m, doc = validate(manifest)
            if args.apply:
                print('清理完成，备份：' + str(apply(manifest, m, doc, check)))
            else:
                print('dry-run（未修改）：' + str(manifest))
                print('目标数：' + str(len(m['targets'])))
                for target in m['targets']:
                    print('目标路径：' + target['dir'])
                print('保护路径：' + ', '.join(m['protectedPaths']))
                print('保留共享 attachments；不扫描或删除项目。执行前必须关闭全部共享 roots 的 Host。')
        return 0
    except (SafetyError, OSError, ValueError, KeyError, TypeError, AttributeError, IndexError) as error:
        print('拒绝或失败：' + str(error), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
