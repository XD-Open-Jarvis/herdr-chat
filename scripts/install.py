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
    for name in MODS:
        run([binary, 'check', str(home/'mods'/name)], home)
    run([binary, 'do', 'layout.switch', json.dumps({'name':'chat'})], home)
    run([binary, 'status'], home)
    print('Backup:', backup)
    print('Updated. Supported Claude/Codex terminals now show 对话 / 终端, even before a chat exists.')
    print('No session data, settings, or other layouts were copied.')
    return 0

if __name__ == '__main__':
    sys.exit(main())
