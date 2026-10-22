import http.client
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import tempfile
import threading
import types
import unittest
from unittest.mock import patch

from attendance_service import Handler, Attendance
from attendance_store import Store


class APITests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory();self.addCleanup(self.temp.cleanup)
        self.store=Store(Path(self.temp.name)/'test.sqlite','model-test')
        self.server=ThreadingHTTPServer(('127.0.0.1',0),Handler)
        self.server.app=types.SimpleNamespace(token='fixture-admin-token',store=self.store)
        thread=threading.Thread(target=self.server.serve_forever,daemon=True);thread.start()
        self.addCleanup(self.server.server_close);self.addCleanup(self.server.shutdown)

    def request(self,path,token='fixture-admin-token'):
        connection=http.client.HTTPConnection(*self.server.server_address,timeout=3)
        connection.request('GET',path,headers={'Authorization':'Bearer '+token})
        response=connection.getresponse();body=json.load(response);connection.close();return response.status,body

    def test_changes_auth_queries_and_cursor(self):
        self.assertEqual(self.request('/api/attendance/changes?after=0&limit=200')[0],200)
        self.assertEqual(self.request('/api/attendance/changes?after=0',token='wrong')[0],401)
        for query in ['after=1','after=-1','after=abc','limit=0','limit=501','after=0&after=0','after=','after=0&other=x']:
            with self.subTest(query=query):self.assertEqual(self.request('/api/attendance/changes?'+query)[0],400)
        status,body=self.request('/api/attendance');self.assertEqual(status,200);self.assertEqual(body,{'records':[]})

    def test_new_enrollment_prepares_audio_on_gpu_only_and_failure_leaves_no_person(self):
        app=Attendance.__new__(Attendance);app.config={};app.store=self.store;app.model={'modelId':'model-test'}
        app.pipeline_lock=threading.Lock();app.pipeline=types.SimpleNamespace(embed=lambda image:([1.]+[0.]*511,None))
        fake=types.ModuleType('facekit.core');fake.decode_image=lambda raw:object()
        with patch.dict('sys.modules',{'facekit.core':fake}),patch('attendance_service.prepare_voice',return_value=b'\xd5'*8000) as prepare:
            result=app.enroll({'person_id':'new-1','name':'测试','photo_base64':'YWJj'})
            self.assertEqual(result['person_id'],'new-1');prepare.assert_called_once()
        with patch.dict('sys.modules',{'facekit.core':fake}),patch('attendance_service.prepare_voice',side_effect=RuntimeError('tts_missing')):
            with self.assertRaises(RuntimeError):app.enroll({'person_id':'failed','name':'测试','photo_base64':'YWJj'})
        self.assertEqual([p['person_id'] for p in self.store.people()],['new-1'])


if __name__=='__main__':unittest.main()
