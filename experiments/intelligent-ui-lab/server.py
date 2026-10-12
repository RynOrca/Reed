"""Local-only UI generation lab. Python standard library, no dependencies."""
import json
import os
import time
from http.client import IncompleteRead
import urllib.request
import urllib.error
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

ROOT = Path(__file__).resolve().parent
# Count UTF-8 content independently of SSE envelopes and provider metadata.
MAX_CONTENT_BYTES = 16 * 1024 * 1024
MAX_REASONING_BYTES = 32 * 1024 * 1024
MAX_WIRE_BYTES = 256 * 1024 * 1024
MAX_EVENT_BYTES = 8 * 1024 * 1024
MAX_JSON_BYTES = 80 * 1024 * 1024
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
    body = dict(model=data['model'].strip(), messages=[dict(role='system', content=SYSTEM), *messages], stream=True)
    budget = data.get('maxTokens')
    if budget is not None and str(budget).strip():
        try:
            budget = int(str(budget).strip())
        except (ValueError, TypeError):
            raise ValueError('最大输出必须是整数，或留空使用服务默认值')
        if not 512 <= budget <= 1_048_576:
            raise ValueError('最大输出应在 512 到 1048576 之间，或留空；具体可用上限由服务决定')
        body['max_tokens'] = budget
    protocol, effort = data.get('protocol', 'none'), data.get('effort', 'medium')
    if effort not in ('off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'):
        raise ValueError('不支持的思考档位')
    enabled = effort != 'off'
    if protocol == 'reasoning_effort':
        body['reasoning_effort'] = 'none' if not enabled else effort
    elif protocol == 'qwen':
        body['chat_template_kwargs'] = dict(enable_thinking=enabled)
    elif protocol == 'deepseek':
        body['thinking'] = dict(type='enabled' if enabled else 'disabled')
        if enabled:
            body['reasoning_effort'] = {'minimal': 'low', 'low': 'low', 'medium': 'high', 'high': 'high', 'xhigh': 'high', 'max': 'max'}[effort]
    elif protocol != 'none':
        raise ValueError('不支持的思考格式')
    endpoint = base if base.endswith('/chat/completions') else base + '/chat/completions'
    return endpoint, body

def read_provider(response, emit):
    """Parse SSE events (including multiline data), or a JSON-only provider."""
    result = dict(content='', reasoning='', usage=None, finishReason=None)
    content_bytes, reasoning_bytes = 0, 0

    def append(content, reasoning):
        nonlocal content_bytes, reasoning_bytes
        if not isinstance(content, str) or not isinstance(reasoning, str):
            raise ValueError('接口返回了不支持的内容格式')
        content_bytes += len(content.encode('utf-8'))
        reasoning_bytes += len(reasoning.encode('utf-8'))
        if content_bytes > MAX_CONTENT_BYTES:
            raise ValueError('实际页面正文超过测试台限制（16 MiB）；已接收内容保留。请简化页面或限制输出预算。')
        if reasoning_bytes > MAX_REASONING_BYTES:
            raise ValueError('实际思考内容超过测试台限制（32 MiB）；已接收内容保留。可降低思考档位。')
        result['content'] += content
        result['reasoning'] += reasoning
        if content or reasoning:
            emit(dict(type='delta', content=content, reasoning=reasoning))

    if 'text/event-stream' not in response.headers.get('Content-Type', '').lower():
        raw = response.read(MAX_JSON_BYTES + 1)
        if len(raw) > MAX_JSON_BYTES:
            raise ValueError('模型 JSON 响应超过传输限制（80 MiB）')
        payload = json.loads(raw)
        choice = payload['choices'][0]
        message = choice['message']
        result.update(usage=payload.get('usage'), finishReason=choice.get('finish_reason'))
        append(message.get('content') or '', message.get('reasoning_content') or message.get('reasoning') or '')
        return result
    start, size, done = time.monotonic(), 0, False
    pending, pending_bytes = [], 0

    def event(lines):
        nonlocal done
        data = '\n'.join(lines)
        if data.strip() == '[DONE]':
            done = True
            return
        payload = json.loads(data)
        if payload.get('error'):
            raise ValueError('模型在流中返回错误，生成未完成；请检查服务日志或稍后重试')
        if payload.get('usage'):
            result['usage'] = payload['usage']
        for choice in payload.get('choices', []):
            if choice.get('index', 0) != 0:
                continue
            delta = choice.get('delta') or {}
            content = delta.get('content') or ''
            reasoning = delta.get('reasoning_content') or delta.get('reasoning') or ''
            append(content, reasoning)
            if choice.get('finish_reason'):
                result['finishReason'] = choice['finish_reason']

    while not done:
        if time.monotonic() - start > 600:
            raise TimeoutError('生成超过 10 分钟')
        line = response.readline(MAX_EVENT_BYTES + 1)
        if not line:
            if pending:
                event(pending)
            break
        size += len(line)
        if len(line) > MAX_EVENT_BYTES:
            raise ValueError('单行 SSE 消息超过传输限制（8 MiB），不是正文累计上限')
        if size > MAX_WIRE_BYTES:
            raise ValueError('SSE 总传输量超过限制（256 MiB，含协议字段）；已接收内容保留。')
        text = line.decode('utf-8').rstrip('\r\n')
        if not text:
            if pending:
                event(pending)
                pending = []
                pending_bytes = 0
            else:
                emit(dict(type='heartbeat'))
        elif text.startswith(':'):
            emit(dict(type='heartbeat'))
        elif text.startswith('data:'):
            pending_bytes += len(line)
            if pending_bytes > MAX_EVENT_BYTES:
                raise ValueError('单个 SSE 事件超过传输限制（8 MiB）')
            pending.append(text[5:].lstrip(' '))
    if not done and not result['finishReason']:
        raise IncompleteRead(b'')
    return result

def connection_error(exc):
    if isinstance(exc, IncompleteRead):
        return '模型响应未完整传输，连接提前断开（IncompleteRead）。这不代表模型无法生成；已接收的内容保留在输出详情。可先连接测试，再降低思考强度或输出预算后重试。'
    if isinstance(exc, (TimeoutError, OSError)):
        return f'模型连接中断或等待超时（{type(exc).__name__}）；请检查网络、代理和服务状态。已收到的输出会保留。'
    if isinstance(exc, (ValueError, KeyError, IndexError, TypeError)):
        return str(exc)
    return f'模型请求失败（{type(exc).__name__}）；请检查服务状态及响应格式。'

class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None

class Handler(BaseHTTPRequestHandler):
    def emit(self, event):
        self.wfile.write((json.dumps(event, ensure_ascii=False) + '\n').encode())
        self.wfile.flush()

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
        if self.path not in ('/api/generate', '/api/test'):
            self.send_error(404)
            return
        origin = self.headers.get('Origin')
        host = self.headers.get('Host', '')
        if host not in (f'127.0.0.1:{self.server.server_port}', f'localhost:{self.server.server_port}') or origin != f'http://{host}' or self.headers.get('X-Lab-Request') != '1':
            self.reply(403, {'error': '仅允许测试台页面发起请求'})
            return
        streaming = False
        try:
            size = int(self.headers.get('Content-Length', 0))
            if not 0 < size <= 2_000_000:
                raise ValueError('请求过大或为空')
            data = json.loads(self.rfile.read(size))
            endpoint, body = build_request(data)
            if self.path == '/api/test':
                body['messages'] = [dict(role='user', content='只回复 OK，不要解释。')]
                body['max_tokens'] = 64
                body.pop('reasoning_effort', None)
                if data.get('protocol') == 'qwen':
                    body['chat_template_kwargs'] = dict(enable_thinking=False)
                elif data.get('protocol') == 'deepseek':
                    body['thinking'] = dict(type='disabled')
            headers = {'Content-Type': 'application/json'}
            key = str(data.get('key', '')).strip()
            if key:
                headers['Authorization'] = 'Bearer ' + key
            request = urllib.request.Request(endpoint, json.dumps(body).encode(), headers)
            # Do not inherit unrelated system proxy configuration for local inference.
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
            with opener.open(request, timeout=120) as response:
                streaming = bool(data.get('clientStream'))
                if streaming:
                    self.send_response(200)
                    self.send_header('Content-Type', 'application/x-ndjson; charset=utf-8')
                    self.send_header('Cache-Control', 'no-store')
                    self.send_header('X-Accel-Buffering', 'no')
                    self.end_headers()
                    self.emit(dict(type='connected'))
                result = read_provider(response, self.emit if streaming else lambda event: None)
            content = result['content']
            if not isinstance(content, str) or not content.strip():
                raise ValueError('模型没有返回页面正文，可能只有思考内容；请提高输出上限或降低思考档位')
            if streaming:
                self.emit(dict(type='result', **result))
            else:
                self.reply(200, result)
        except urllib.error.HTTPError as exc:
            code = exc.code
            exc.close()
            meanings = {400: '请求参数不兼容，请检查思考格式和输出预算', 401: 'API Key 无效或缺失', 402: '账户余额不足', 403: '接口访问被拒绝', 404: '地址或模型不存在', 429: '请求限流，请稍后重试', 500: '模型服务内部错误', 503: '模型服务繁忙'}
            self.reply(502, {'error': f'模型接口 HTTP {code}：{meanings.get(code, "上游请求失败")}。'})
        except (BrokenPipeError, ConnectionResetError):
            pass  # Browser closed or cancelled; do not attempt a second response.
        except Exception as exc:
            error = connection_error(exc)
            if streaming:
                self.emit(dict(type='error', error=error))
            else:
                self.reply(502, {'error': error})

if __name__ == '__main__':
    port = int(os.environ.get('UI_LAB_PORT', '8765'))
    print(f'Intelligent UI Lab: http://127.0.0.1:{port}', flush=True)
    ThreadingHTTPServer(('127.0.0.1', port), Handler).serve_forever()
