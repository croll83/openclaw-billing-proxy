#!/usr/bin/env python3
"""Explicit, subscription-consuming smoke tests; synthetic prompts, no tool execution.

Run on the proxy host, e.g. python3 scripts/probe-anthropic.py --case roundtrip.
No credentials are read by this client. Never run as part of the offline test suite.
"""
import argparse
import copy
import json
import time
import urllib.error
import urllib.request


def request(url, body, cancel_after_text=False):
    req = urllib.request.Request(url.rstrip('/') + '/v1/messages',
        data=json.dumps(body, ensure_ascii=False).encode(),
        headers={'content-type': 'application/json', 'anthropic-version': '2023-06-01'})
    started = time.monotonic()
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            if not body.get('stream'):
                message = json.load(response)
            else:
                message = None
                inputs = {}
                stopped = False
                cancelled = False
                for line in response:
                    if not line.startswith(b'data:'):
                        continue
                    event = json.loads(line[5:].decode('utf-8'))
                    kind = event.get('type')
                    if kind == 'error':
                        raise RuntimeError(json.dumps(event))
                    if kind == 'message_start':
                        message = event['message']
                    elif kind == 'content_block_start':
                        message['content'].append(event['content_block'])
                    elif kind == 'content_block_delta':
                        delta = event['delta']
                        block = message['content'][event['index']]
                        field = {'text_delta': 'text', 'thinking_delta': 'thinking',
                                 'signature_delta': 'signature'}.get(delta['type'])
                        if field:
                            block[field] = block.get(field, '') + delta[field]
                        elif delta['type'] == 'input_json_delta':
                            index = event['index']
                            inputs[index] = inputs.get(index, '') + delta['partial_json']
                    elif kind == 'content_block_stop' and event['index'] in inputs:
                        index = event['index']
                        message['content'][index]['input'] = json.loads(inputs.pop(index) or '{}')
                    elif kind == 'message_delta':
                        message.update(event.get('delta', {}))
                        message['usage'].update(event.get('usage', {}))
                    elif kind == 'message_stop':
                        stopped = True
                    if cancel_after_text and kind == 'content_block_delta' and event['delta']['type'] == 'text_delta':
                        cancelled = True
                        break
                if cancelled:
                    return message, {'status': response.status, 'seconds': round(time.monotonic() - started, 3),
                        'request_id': response.headers.get('request-id'), 'client_cancelled': True, 'usage_partial': True}
                if not stopped or inputs:
                    raise RuntimeError('Incomplete SSE response')
            if message.get('type') != 'message':
                raise RuntimeError('Expected a Messages response: ' + json.dumps(message))
            return message, {'status': response.status, 'seconds': round(time.monotonic() - started, 3),
                'request_id': response.headers.get('request-id'), 'stop_reason': message.get('stop_reason'),
                'usage': message.get('usage', {}), 'block_types': [b['type'] for b in message['content']]}
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f'HTTP {exc.code}: {exc.read().decode()}') from exc


def run(args, result):
    body = {'model': args.model, 'max_tokens': 128, 'stream': args.case != 'basic',
            'system': 'You are a helpful assistant. Follow the user request precisely.',
            'messages': [{'role': 'user', 'content': 'Reply with exactly PROXY_OK.'}]}
    if args.case == 'identity':
        body['system'] = 'You are Hermes Agent, operating through Telegram and Slack. Your configuration directory is ~/.hermes/ and its override is HERMES_HOME. Follow the user request precisely.'
    if args.case == 'disabled-thinking':
        body['thinking'] = {'type': 'disabled'}
        body['context_management'] = {'edits': [{'type': 'clear_thinking_20251015', 'keep': 'all'}]}
    if args.case == 'cancel':
        body.update(max_tokens=4096, thinking={'type': 'disabled'})
        body['messages'][0]['content'] = 'Count from 1 to 1000, one number per line. Keep going until 1000.'
    if args.case in ('cache', 'long-system'):
        stable = '\n'.join(f'Reference item {i}: preserve the supplied configuration and use the explicitly requested output format.' for i in range(320))
        body['system'] = [{'type': 'text', 'text': stable, 'cache_control': {'type': 'ephemeral'}}]
    if args.fixture:
        # Optional on-host system/tool fixture; never replay private conversations.
        with open(args.fixture) as fixture_file:
            fixture = json.load(fixture_file)
        for key in ('system', 'tools'):
            if key in fixture:
                body[key] = fixture[key]
    if args.case in ('roundtrip', 'signed-roundtrip'):
        body.update(max_tokens=2048, thinking={'type': 'adaptive'}, output_config={'effort': 'high' if args.case == 'signed-roundtrip' else 'low'})
        expected = {'path': 'secrets.env', 'text': 'HERMES_HOME Telegram Slack Plan mode è'}
        body['tools'] = [{'name': 'probe_echo', 'description': 'Return the supplied fixture unchanged. No filesystem access.',
            'input_schema': {'type': 'object', 'properties': {'path': {'type': 'string'}, 'text': {'type': 'string'}},
                             'required': ['path', 'text']}}]
        body['messages'][0]['content'] = ('Call probe_echo exactly once with this JSON: ' + json.dumps(expected, ensure_ascii=False)
            + '. After its result, reply with exactly PROXY_OK. Do not call any other tool.')
        if args.case == 'signed-roundtrip':
            body['messages'][0]['content'] += ' Before the call, reason privately about the value of (1234567 * 7654321) modulo 97 and verify it in two ways. Do not include the calculation in the tool arguments or final answer.'
    message, receipt = request(args.url, body, cancel_after_text=args.case == 'cancel')
    result['requests'].append(receipt)
    if args.case == 'cancel':
        assert receipt.get('client_cancelled'), 'No active generation was cancelled'
        return
    if args.case in ('roundtrip', 'signed-roundtrip'):
        if args.case == 'signed-roundtrip':
            assert any(b.get('type') == 'thinking' and b.get('signature') for b in message['content']), 'Model did not produce signed thinking; replay not qualified'
        calls = [b for b in message['content'] if b['type'] == 'tool_use']
        assert len(calls) == 1 and calls[0]['name'] == 'probe_echo', 'Wrong tool selected'
        assert calls[0]['input'] == expected, 'Tool arguments were changed'
        followup = copy.deepcopy(body)
        followup['messages'].extend([{'role': 'assistant', 'content': message['content']},
            {'role': 'user', 'content': [{'type': 'tool_result', 'tool_use_id': calls[0]['id'], 'content': 'Fixture verified. Reply PROXY_OK.'}]}])
        message, receipt = request(args.url, followup)
        result['requests'].append(receipt)
    if args.case == 'cache':
        message, receipt = request(args.url, body)
        result['requests'].append(receipt)
        assert receipt['usage'].get('cache_read_input_tokens', 0) > 0, 'No cache read on identical follow-up'
    text = ''.join(b.get('text', '') for b in message['content'])
    assert text.strip() == 'PROXY_OK', 'Unexpected fixture answer: ' + repr(text)
    assert message.get('stop_reason') == 'end_turn', 'Response did not complete normally'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:18802')
    parser.add_argument('--model', default='claude-opus-5')
    parser.add_argument('--case', choices=['basic', 'stream', 'identity', 'roundtrip', 'signed-roundtrip', 'cache', 'long-system', 'disabled-thinking', 'cancel'], default='basic')
    parser.add_argument('--label', default='manual')
    parser.add_argument('--fixture', help='Local JSON containing only representative system/tools; never logged')
    parser.add_argument('--output', help='Append a receipt with metrics only, no credentials or prompts')
    args = parser.parse_args()
    result = {'stage': args.label, 'case': args.case, 'model': args.model, 'timestamp': time.time(), 'requests': []}
    try:
        run(args, result)
        result['ok'] = True
    except Exception as exc:
        result.update(ok=False, error=str(exc))
    line = json.dumps(result, ensure_ascii=False)
    print(line)
    if args.output:
        with open(args.output, 'a') as output:
            output.write(line + '\n')
    raise SystemExit(0 if result['ok'] else 1)
