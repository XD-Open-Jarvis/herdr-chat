import contextlib
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('chat_install', Path(__file__).resolve().parents[1]/'scripts/install.py')
install = importlib.util.module_from_spec(spec)
spec.loader.exec_module(install)

class InstallTests(unittest.TestCase):
    def invoke(self, home, *flags):
        with patch.object(sys, 'argv', ['install.py', '--home', str(home), *flags]), \
             patch.object(install, 'cli', return_value='/fake/herdr-app'), \
             patch.object(install, 'run'), patch.object(install, 'migrate_chats'), contextlib.redirect_stdout(io.StringIO()):
            return install.main()

    def test_dry_run_does_not_write(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)/'home'
            self.assertEqual(self.invoke(home),0)
            self.assertFalse(home.exists())

    def test_update_backs_up_code_and_preserves_sessions_and_conflicting_keys(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            code=home/'mods/chat-pane/main.js';code.parent.mkdir(parents=True)
            code.write_text('old header')
            keys=home/'keys.json';original=json.dumps({'global':{'cmd-shift-n':'space.new','secondary-shift-n':'space.new'}})
            keys.write_text(original)
            state=home/'shared.json';state.write_text('{"private":"keep"}')
            self.assertEqual(self.invoke(home,'--update'),0)
            self.assertEqual(keys.read_text(),original)
            self.assertEqual(state.read_text(),'{"private":"keep"}')
            backup=list((home/'backups').iterdir())[0]
            self.assertEqual((backup/'mods/chat-pane/main.js').read_text(),'old header')
            self.assertEqual(code.read_bytes(),(install.ROOT/'mods/chat-pane/main.js').read_bytes())
            self.assertEqual(self.invoke(home,'--diagnose'),0)

    def test_diagnosis_detects_partial_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            self.invoke(home,'--update')
            (home/'mods/chat-pane/main.js').write_text('outdated')
            self.assertEqual(self.invoke(home,'--diagnose'),1)

    def test_diagnosis_accepts_runtime_border_changes_but_requires_header_routing(self):
        with tempfile.TemporaryDirectory() as tmp:
            home=Path(tmp)
            self.invoke(home,'--update')
            p=home/'layouts/chat.json';layout=json.loads(p.read_text())
            def change(node):
                content=node.get('content',{})
                if content.get('tab')=='active':
                    content['pane']['focus']['color']='accent'
                    content['pane']['header']['content']['mod']='pane'
                for child in node.get('children',[]):change(child)
            change(layout);p.write_text(json.dumps(layout))
            self.assertEqual(self.invoke(home,'--diagnose'),1)


class MigrationTests(unittest.TestCase):
    def test_only_chat_binding_props_change_and_migration_is_idempotent(self):
        old={'spaces':[{'id':'s1','tabs':[{'id':'tb1','root':{'id':'root','children':[
            {'id':'p-chat','content':{'mod':'chat','props':{'terminal':'old-alias/t8','model':'keep'}}},
            {'id':'p-shell','content':{'terminal':'t8'}},
            {'id':'p-file','content':{'mod':'files','props':{'terminal':'anything'}}}
        ]}}]}], 'future': {'keep':True}}
        original=json.loads(json.dumps(old))
        updated,count=install.migrate_document(old)
        self.assertEqual(count,1)
        self.assertEqual(old,original)
        children=updated['spaces'][0]['tabs'][0]['root']['children']
        self.assertEqual(children[0]['content']['props'],{'terminal':'t8','owner_tab':'tb1','owner_pane':'p-chat','model':'keep'})
        self.assertEqual(children[1:],old['spaces'][0]['tabs'][0]['root']['children'][1:])
        self.assertEqual(updated['future'],old['future'])
        self.assertEqual(install.migrate_document(updated),(updated,0))

    def test_conflicts_reread_new_layout_before_retrying(self):
        from types import SimpleNamespace
        old={'spaces':[{'tabs':[{'id':'tb1','root':{'id':'p1','content':{'mod':'chat','props':{'terminal':'mini/t8'}}}}]}]}
        reads=[{'value':old,'version':1},{'value':{**old,'concurrent':'keep'},'version':2}]
        writes=[]
        def rpc(binary, method, params):
            if method=='doc.get':return reads.pop(0)
            writes.append(params)
            if len(writes)==1:
                error=RuntimeError('conflict');error.conflict=True;raise error
            return {'version':3}
        with tempfile.TemporaryDirectory() as tmp, \
             patch.object(install,'core_rpc',side_effect=rpc), \
             patch.object(install.subprocess,'run',return_value=SimpleNamespace(stdout='{"machines":[]}')), \
             contextlib.redirect_stdout(io.StringIO()):
            install.migrate_chats(Path(tmp),Path(tmp))
            self.assertEqual(writes[0]['version'],1)
            self.assertEqual(writes[1]['version'],2)
            self.assertEqual(writes[1]['value']['concurrent'],'keep')
            self.assertEqual(len(list(Path(tmp).glob('herdr-app-doc-*.json'))),2)

if __name__ == '__main__':
    unittest.main()
