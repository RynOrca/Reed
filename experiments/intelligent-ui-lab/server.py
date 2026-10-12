"""Local-only UI generation lab. Python standard library, no dependencies."""
import json
import os
import urllib.request
import urllib.error
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
SYSTEM = """你是交互学习页面开发者。根据用户问题生成一个完整、独立、可离线运行的 HTML 文档。
只返回 HTML（允许一个 html 代码围栏），不要返回其他说明。使用中文界面。
HTML 内嵌 CSS 和 JavaScript，不使用外部库、网络请求、图片链接或 CDN。
优先用 SVG、Canvas、原生 DOM。页面自适应，文本清晰、对比足够。
算法演示提供上一步、下一步、重置，显示输入、当前状态、关键变量、对应伪代码行与步骤原因。
严格区分算法变体，注明下标和约定。不要伪造真实训练或真实模型内部数据，示例数据明确标为示例。
公式、模拟、边界条件必须自洽；不确定的内容在页面中说明限制。
控件必须真正工作。先计算完整状态序列，再通过索引播放，确保后退和重置正确。
用户要求修改时返回修改后的完整文档。禁止访问父页面、宿主 API、存储或弹窗。"""

def build_request(data):
    base = str(data.get('base', '')).strip().rstrip('/')
    parts = urlsplit(base)
    if parts.scheme not in ('http', 'https') or not parts.hostname or parts.username or parts.password or parts.query or parts.fragment:
        raise ValueError('Base URL 必须是不含账号、查询参数的 HTTP(S) 地址')
    if not data.get('model', '').strip():
        raise ValueError('请填写 Model ID')
    messages = data.get('messages', [])
    if not messages or len(messages) > 30 or any(m.get('role') not in ('user', 'assistant') or not isinstance(m.get('content'), str) for m in messages):
        raise ValueError('任务或对话格式无效（最多 30 条消息）')
    body = dict(model=data['model'].strip(), messages=[dict(role='system', content=SYSTEM), *messages], stream=False)
    budget = int(data.get('maxTokens', 8192))
    if not 512 <= budget <= 65536:
        raise ValueError('输出 token 上限应在 512 到 65536 之间')
    body['max_tokens'] = budget
    protocol, effort = data.get('protocol', 'none'), data.get('effort', 'medium')
    if effort not in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh'):
        raise ValueError('不支持的思考档位')
    enabled = effort != 'off'
    if protocol == 'reasoning_effort':
        body['reasoning_effort'] = 'none' if not enabled else effort
    elif protocol == 'qwen':
        body['chat_template_kwargs'] = dict(enable_thinking=enabled)
    elif protocol == 'deepseek':
        body['thinking'] = dict(type='enabled' if enabled else 'disabled')
    elif protocol != 'none':
        raise ValueError('不支持的思考格式')
    endpoint = base if base.endswith('/chat/completions') else base + '/chat/completions'
    return endpoint, body

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass  # Never log prompts or credentials.

    def reply(self, status, data):
        raw = json.dumps(data, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Cache-Control', 'no-store')
        self.send_header('Content-Length', str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)

    def do_GET(self):
        files = {'/': 'index.html', '/app.js': 'app.js', '/style.css': 'style.css'}
        name = files.get(self.path.split('?')[0])
        if not name:
            self.send_error(404)
            return
        raw = (ROOT / name).read_bytes()
        self.send_response(200)
        self.send_header('Content-Type', {'html': 'text/html', 'js': 'text/javascript', 'css': 'text/css'}[name.split('.')[-1]] + '; charset=utf-8')
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Cache-Control', 'no-store')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.end_headers()
        self.wfile.write(raw)

    def do_POST(self):
        if self.path != '/api/generate':
            self.send_error(404)
            return
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}') or origin != f'http://{host}' or self.headers.get('X-Lab-Request') != '1':
            self.reply(403, {'error': '仅允许测试台页面发起请求'})
            return
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 2_000_000:
                raise ValueError('请求过大或为空')
            data = json.loads(self.rfile.read(size))
            endpoint, body = build_request(data)
            headers = {'Content-Type': 'application/json'}
            key = str(data.get('key', '')).strip()
            if key:
                headers['Authorization'] = 'Bearer ' + key
            request = urllib.request.Request(endpoint, json.dumps(body).encode(), headers)
            # Do not inherit unrelated system proxy configuration for local inference.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(request, timeout=600) as response:
                raw = response.read(4_000_001)
                if len(raw) > 4_000_000:
                    raise ValueError('模型响应超过 4MB')
                result = json.loads(raw)
            choice = result['choices'][0]
            message = choice['message']
            content = message.get('content') or ''
            if not isinstance(content, str) or not content.strip():
                raise ValueError('模型没有返回页面正文，可能只有思考内容；请提高输出上限或降低思考档位')
            self.reply(200, dict(content=content, reasoning=message.get('reasoning_content') or message.get('reasoning') or '', usage=result.get('usage'), finishReason=choice.get('finish_reason')))
        except urllib.error.HTTPError as exc:
            code = exc.code
            exc.close()
            self.reply(502, {'error': f'模型接口 HTTP {code}。请检查地址、凭据、模型名及思考格式；可先选择“不发送”再试。'})
        except (ValueError, KeyError, IndexError, TypeError) as exc:
            self.reply(400, {'error': str(exc)})
        except Exception as exc:
            self.reply(502, {'error': f'连接模型失败（{type(exc).__name__}）。检查服务是否启动、地址是否可访问；请求最长等待 10 分钟。'})

if __name__ == '__main__':
    port = int(os.environ.get('UI_LAB_PORT', '8765'))
    print(f'Intelligent UI Lab: http://127.0.0.1:{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
