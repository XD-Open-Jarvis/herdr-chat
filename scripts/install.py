#!/usr/bin/env python3
"""Install/update this fork's Chat files, or diagnose an existing installation."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from datetime import datetime

ROOT = Path(__file__).resolve().parents[1]
MODS = ['chat', 'chat-file', 'chat-pane', 'chat-tabs', 'spaces-chat']

def files():
    result = [Path('layouts/chat.json'), Path('layouts/chat.svg')]
    for name in MODS:
        for path in sorted((ROOT / 'mods' / name).rglob('*')):
            if path.is_file() and (path.suffix in ('.js', '.svg') or path.name in ('mod.json', 'LICENSE')):
                result.append(path.relative_to(ROOT))
    return result

def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else None

def matches(path, home):
    if str(path) != 'layouts/chat.json':
        return digest(ROOT/path) == digest(home/path)
    # Herdr rewrites personal layout JSON after clicks/layout.set. Compare
    # required routing, not whitespace, preview metadata or runtime focus color.
    try:
        tree = json.loads((home/path).read_text())
        nodes = {}
        def walk(node):
            nodes[node.get('id')] = node
            for child in node.get('children', []):
                walk(child)
        walk(tree)
        header = nodes['main']['content']['pane']['header']
        return (header['content']['mod'] == 'chat-pane' and header['height'] == 44
                and nodes['tabs']['content']['mod'] == 'chat-tabs'
                and nodes['spaces']['content']['mod'] == 'spaces-chat')
    except (OSError, ValueError, KeyError, TypeError):
        return False

def cli():
    candidates = [shutil.which('herdr-app'), str(Path.home()/'.local/bin/herdr-app'),
                  '/Applications/Agents/Herdr.app/Contents/MacOS/Herdr',
                  '/Applications/Herdr.app/Contents/MacOS/Herdr']
    return next((path for path in candidates if path and Path(path).is_file()), None)

def run(command, home, check=True):
    return subprocess.run(command, env={**os.environ, 'HERDR_APP_HOME': str(home)}, check=check)

def migrate_document(value):
    """Only normalize Chat props, never terminals, splits or other document fields."""
    updated = json.loads(json.dumps(value))
    count = 0
    def local(value):
        return value.rsplit('/', 1)[-1] if isinstance(value, str) else value
    def walk(node, tab):
        nonlocal count
        content = node.get('content', {})
        props = content.get('props')
        if content.get('mod') == 'chat' and isinstance(props, dict) and props.get('terminal'):
            normalized = {**props, 'terminal': local(props['terminal']),
                          'owner_tab': local(tab), 'owner_pane': local(node['id'])}
            if normalized != props:
                content['props'] = normalized
                count += 1
        for child in node.get('children', []):
            walk(child, tab)
    for space in (updated or {}).get('spaces', []):
        for tab in space.get('tabs', []):
            walk(tab['root'], tab['id'])
    return updated, count


def core_rpc(binary, method, params):
    request = {'jsonrpc':'2.0', 'id':1, 'method':method, 'params':params}
    result = subprocess.run([binary, 'connect'], input=json.dumps(request)+'\n',
                            text=True, capture_output=True, timeout=15, check=True)
    for line in result.stdout.splitlines():
        response = json.loads(line)
        if response.get('id') != 1:
            continue
        if 'error' in response:
            error = RuntimeError(str(response['error']))
            error.conflict = response['error'].get('data', {}).get('kind') == 'conflict'
            raise error
        return response['result']
    raise RuntimeError('No core reply for '+method)


def migrate_chats(home, backup):
    binary = shutil.which('hc') or str(Path.home()/'.local/bin/hc')
    listing = subprocess.run([binary, 'machine', 'ls', '--json'], text=True,
                             capture_output=True, timeout=15, check=True)
    machines = [None] + [m['name'] for m in json.loads(listing.stdout).get('machines', [])
                          if not m.get('temporary')]
    for index, machine in enumerate(machines):
        params = {'name':'herdr-app', **({'on':machine} if machine else {})}
        for attempt in range(3):
            saved = core_rpc(binary, 'doc.get', params)
            updated, count = migrate_document(saved['value'])
            if not count:
                break
            # Keep the exact source document before a version-checked write.
            path = backup/('herdr-app-doc-'+str(index)+'-v'+str(saved['version'])+'.json')
            path.write_text(json.dumps(saved, indent=2, ensure_ascii=False)+'\n')
            try:
                core_rpc(binary, 'doc.set', {**params, 'version':saved['version'], 'value':updated})
                print('Migrated', count, 'Chat pane bindings on', machine or 'this machine')
                break
            except RuntimeError as error:
                if not getattr(error, 'conflict', False) or attempt == 2:
                    raise
                # Re-read and reapply only the props patch; never overwrite a newer layout.


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--home', type=Path, default=Path(os.environ.get('HERDR_APP_HOME', str(Path.home()/'.config/herdr-app'))))
    parser.add_argument('--update', action='store_true', help='back up and replace this fork’s files, validate, then select chat')
    parser.add_argument('--diagnose', action='store_true', help='read-only version/file/status checks')
    args = parser.parse_args()
    home = args.home.expanduser().resolve()
    binary = cli()
    if not binary:
        parser.error('Herdr App was not found. Install/start it once, then run this script again.')
    run([binary, '--version'], home)
    if args.diagnose:
        mismatches = [str(path) for path in files() if not matches(path, home)]
        for path in mismatches:
            print('MISSING OR DIFFERENT:', path)
        if not mismatches:
            print('All Chat layout/mod files match this checkout.')
        run([binary, 'status'], home, check=False)
        return 1 if mismatches else 0
    if not args.update:
        print('Would install/update', len(files()), 'files in', home)
        print('Run with --update to back up and apply, or --diagnose for read-only checks.')
        return 0
    # Validate source against this Mac's runtime before touching the installed files.
    for name in MODS:
        run([binary, 'check', str(ROOT/'mods'/name)], home)
    keyfile = home/'keys.json'
    keys = json.loads(keyfile.read_text()) if keyfile.is_file() else {}
    global_keys = keys.setdefault('global', {})
    key = 'cmd-shift-n' if sys.platform == 'darwin' else 'ctrl-shift-n'
    aliases = (key, 'secondary-shift-n')
    conflict = any(k in global_keys and global_keys[k] != 'mod.open:chat' for k in aliases)
    backup = home/'backups'/('chat-customized-'+datetime.now().strftime('%Y%m%d-%H%M%S-%f'))
    backup.mkdir(parents=True, exist_ok=False)
    for path in files():
        target = home/path
        if target.exists():
            saved = backup/path
            saved.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(target, saved)
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(ROOT/path, target)
    if conflict:
        print('Kept your existing new-chat shortcut binding; use the header’s 对话 button.')
    elif not any(k in global_keys for k in aliases):
        if keyfile.exists():
            shutil.copy2(keyfile, backup/'keys.json')
        global_keys[key] = 'mod.open:chat'
        keyfile.write_text(json.dumps(keys, indent=2, ensure_ascii=False)+'\n')
    migrate_chats(home, backup)
    for name in MODS:
        run([binary, 'check', str(home/'mods'/name)], home)
    run([binary, 'do', 'layout.switch', json.dumps({'name':'chat'})], home)
    run([binary, 'status'], home)
    print('Backup:', backup)
    print('Updated. Supported Claude/Codex terminals now show 对话 / 终端, even before a chat exists.')
    print('Only Chat binding props were migrated; transcripts, terminal structure, settings and other layouts were preserved.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
