"""Isolated provider tests; --serve exposes the mock for manual browser QA."""
import json
import threading
import unittest
import urllib.request
import urllib.error
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from server import build_request, Handler

HTML = '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body><h1>隔离测试作品</h1><p>这是模拟接口，不是真实模型生成。</p><button onclick="document.getElementById(\'step\').textContent=Number(document.getElementById(\'step\').textContent)+1">下一步</button><output id="step">0</output></body></html>'

class Mock(BaseHTTPRequestHandler):
    received = None
    def log_message(self, *args):
        pass
    def do_POST(self):
        Mock.received = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        if Mock.received['model'] == 'mock-error':
            self.send_response(401)
            self.end_headers()
            return
        raw = json.dumps({'choices': [{'message': {'content': HTML, 'reasoning_content': '模拟思考'}, 'finish_reason': 'stop'}], 'usage': {'completion_tokens': 100}}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

def start(handler, port=0):
    server = ThreadingHTTPServer(('127.0.0.1', port), handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return server

class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock = start(Mock)
        cls.lab = start(Handler)
        cls.url = f'http://127.0.0.1:{cls.lab.server_port}'

    @classmethod
    def tearDownClass(cls):
        cls.mock.shutdown(); cls.lab.shutdown()
        cls.mock.server_close(); cls.lab.server_close()

    def data(self, **kwargs):
        return {'base': f'http://127.0.0.1:{self.mock.server_port}/v1', 'model': 'mock-model', 'messages': [{'role': 'user', 'content': '测试'}], **kwargs}

    def request(self, data, origin=None):
        request = urllib.request.Request(self.url + '/api/generate', json.dumps(data).encode(), {'Content-Type': 'application/json', 'X-Lab-Request': '1', 'Origin': origin or self.url})
        return urllib.request.build_opener(urllib.request.ProxyHandler({})).open(request)

    def test_protocols(self):
        for protocol, expected in [('none', {}), ('reasoning_effort', {'reasoning_effort': 'high'}), ('qwen', {'chat_template_kwargs': {'enable_thinking': True}}), ('deepseek', {'thinking': {'type': 'enabled'}})]:
            _, body = build_request(self.data(protocol=protocol, effort='high'))
            for key, value in expected.items(): self.assertEqual(body[key], value)
            if protocol == 'none': self.assertNotIn('reasoning_effort', body)
        _, body = build_request(self.data(protocol='qwen', effort='off'))
        self.assertFalse(body['chat_template_kwargs']['enable_thinking'])
        _, body = build_request(self.data(protocol='deepseek', effort='off'))
        self.assertEqual(body['thinking']['type'], 'disabled')

    def test_proxy_roundtrip(self):
        with self.request(self.data(protocol='reasoning_effort', effort='low')) as response:
            result = json.load(response)
        self.assertEqual(result['content'], HTML)
        self.assertEqual(result['reasoning'], '模拟思考')
        self.assertEqual(Mock.received['reasoning_effort'], 'low')
        self.assertEqual(Mock.received['messages'][0]['role'], 'system')

    def test_cross_origin_denied(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(self.data(), 'https://unrelated.invalid')
        self.assertEqual(error.exception.code, 403)
        error.exception.close()

    def test_provider_error(self):
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(self.data(model='mock-error'))
        self.assertEqual(error.exception.code, 502)
        error.exception.close()

    def test_invalid_config(self):
        for data in [self.data(base='file:///tmp/x'), self.data(model=''), self.data(maxTokens=1), self.data(messages=[])]:
            with self.assertRaises(ValueError): build_request(data)

if __name__ == '__main__':
    import sys
    if '--serve' in sys.argv:
        print('Mock provider: http://127.0.0.1:8766/v1 (mock-model)', flush=True)
        ThreadingHTTPServer(('127.0.0.1', 8766), Mock).serve_forever()
    else:
        unittest.main()
