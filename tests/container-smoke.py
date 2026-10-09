#!/usr/bin/env python3
"""Container contract check. Requires Docker, Python 3 and a built image.
Usage: python3 tests/container-smoke.py [ai-engine-proxy:2.4.0]
Only the randomly named resources created by this script are removed.
"""
import json
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid

image = sys.argv[1] if len(sys.argv) > 1 else 'ai-engine-proxy:2.4.0'
name = 'engine-check-' + uuid.uuid4().hex[:12]
volume, sidecar = name + '-data', name + '-nginx'

def docker(*args):
    return subprocess.check_output(['docker', *args], stderr=subprocess.STDOUT if args and args[0] == 'logs' else subprocess.PIPE, text=True).strip()

def request(base, route, method='GET', body=None, headers=None):
    headers = dict(headers or {})
    if body is not None:
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(base + route, method=method, headers=headers,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(req, timeout=10) as response:
            return response.status, response.read()
    except urllib.error.HTTPError as response:
        return response.code, response.read()

with tempfile.TemporaryDirectory(prefix='engine-container-') as directory:
    directory = pathlib.Path(directory)
    (directory / 'config.json').write_text(json.dumps({
        'port': 18802, 'bindAddress': '0.0.0.0',
        'management': {'enabled': True, 'port': 18803, 'bindAddress': '127.0.0.1',
                       'databasePath': '/data/proxy.sqlite', 'accountsDirectory': '/data/accounts'},
        'video': {'enabled': True}}))
    (directory / 'nginx.conf').write_text('''events {}
http {
  map $http_origin $engine_origin { "" ""; default "http://127.0.0.1:18803"; }
  server {
    listen 8080;
    location / {
      proxy_pass http://127.0.0.1:18803;
      proxy_set_header Host 127.0.0.1:18803;
      proxy_set_header Origin $engine_origin;
    }
  }
}
''')
    try:
        docker('volume', 'create', volume)
        docker('run', '-d', '--name', name, '--user', '10001:10001', '--workdir', '/data',
               '--env', 'HOME=/data', '--read-only', '--tmpfs', '/tmp:rw,nosuid,nodev,size=128m',
               '--mount', f'type=volume,src={volume},dst=/data',
               '--mount', f'type=bind,src={directory}/config.json,dst=/etc/ai-engine-proxy/config.json,readonly',
               '-p', '127.0.0.1::18802', '-p', '127.0.0.1::8080', image,
               '--config', '/etc/ai-engine-proxy/config.json')
        docker('run', '-d', '--name', sidecar, '--network', f'container:{name}', '--read-only',
               '--tmpfs', '/var/cache/nginx', '--tmpfs', '/var/run',
               '--mount', f'type=bind,src={directory}/nginx.conf,dst=/etc/nginx/nginx.conf,readonly',
               'nginx:stable-bookworm')
        info = json.loads(docker('inspect', name))[0]
        ports = info['NetworkSettings']['Ports']
        api = 'http://127.0.0.1:' + ports['18802/tcp'][0]['HostPort']
        console = 'http://127.0.0.1:' + ports['8080/tcp'][0]['HostPort']
        for attempt in range(30):
            try:
                if request(api, '/health')[0] == 200 and request(console, '/')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.2)
        else:
            raise AssertionError('Listeners did not become healthy')
        baseline = docker('diff', name)
        assert request(api, '/v1/messages', 'POST', {})[0] == 401
        origin = {'Origin': 'https://ai-engine-proxy.hercle.com'}
        assert request(console, '/admin/status', headers=origin)[0] == 200
        headers = {**origin, 'x-proxy-admin': '1'}
        status, body = request(console, '/admin/keys', 'POST', {'name': 'Container check'}, headers)
        assert status == 201
        key = json.loads(body)
        for auth in [{'x-api-key': key['secret']}, {'Authorization': 'Bearer ' + key['secret']}]:
            assert request(api, '/v1/unknown', 'POST', {'model': 'test'}, auth)[0] == 404
        assert request(console, '/admin/keys/' + key['key']['id'], 'DELETE', headers=headers)[0] == 200
        status, body = request(console, '/admin/logins', 'POST', {'name': 'Container login check'}, headers)
        assert status == 201
        login_id = json.loads(body)['id']
        try:
            for attempt in range(60):
                status, body = request(console, '/admin/logins/' + login_id, headers=headers)
                login = json.loads(body)
                if login['status'] == 'awaiting_login':
                    break
                assert login['status'] not in ['failed', 'expired'], login['message']
                time.sleep(.5)
            else:
                raise AssertionError('CLI authorization link timeout')
        finally:
            assert request(console, '/admin/logins/' + login_id, 'DELETE', headers=headers)[0] == 200
        logs = docker('logs', name).lower()
        assert not any(word in logs for word in ['hermes', 'billing', 'anthropic', 'claude', 'gemini', 'openclaw'])
        assert info['HostConfig']['ReadonlyRootfs'] and info['Config']['User'] == '10001:10001'
        assert docker('diff', name) == baseline, 'Unexpected root filesystem change'
        runtime = json.loads(docker('exec', name, 'node', '-e', '''
const fs=require('fs');console.log(JSON.stringify({
 files:fs.readdirSync('/app').sort(),pkg:require('/app/package.json'),uid:process.getuid(),gid:process.getgid(),node:process.version
}));'''))
        assert runtime['files'] == ['LICENSE', 'index.js', 'node_modules', 'package.json', 'src', 'web']
        assert runtime['pkg']['name'] == 'ai-engine-proxy'
        assert not any(k in runtime['pkg'] for k in ['description', 'keywords', 'repository'])
        assert runtime['uid'] == runtime['gid'] == 10001
        # Exercise actual native rasterization and H.264 encoding inside the
        # read-only container, without connecting any account or invoking a model.
        docker('exec', name, 'node', '-e', '''
const fs=require('fs');const {render,preflight}=require('/app/src/video/render');
const dir='/data/container-video-check';fs.mkdirSync(dir,{mode:0o700});
const options={ffmpegPath:'ffmpeg',fontFile:'/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf',maxOutputBytes:52428800};
const plan={scenes:[{duration_seconds:1,background:'#102030',elements:[]}]};
(async()=>{await preflight(options);await render(plan,{format:'square',duration_seconds:1},dir,options,new AbortController().signal);fs.rmSync(dir,{recursive:true});})().catch(()=>process.exit(1));
''')
        cli = docker('exec', name, 'claude', '--version')
        assert cli.startswith('2.1.293 ')
        docker('restart', name)
        info = json.loads(docker('inspect', name))[0]
        api = 'http://127.0.0.1:' + info['NetworkSettings']['Ports']['18802/tcp'][0]['HostPort']
        # Restart retains the volume, exercising the existing entrypoint link.
        for attempt in range(30):
            try:
                if request(api, '/health')[0] == 200:
                    break
            except OSError:
                pass
            time.sleep(.2)
        else:
            raise AssertionError('Restart with existing data volume failed')
        print('PASS: health 200, missing key 401, sidecar console and external Origin 200, both key headers')
        print('PASS: login CLI flow starts and cancels; no account authenticated or generation sent')
        print('PASS: read-only rootfs, uid/gid 10001, neutral startup logs, runtime allowlist, persistent-volume restart')
        print('Runtime:', runtime['node'], '| Login CLI:', cli)
    except BaseException:
        print(docker('logs', name), file=sys.stderr)
        print(docker('inspect', name, '--format', '{{json .State}}'), file=sys.stderr)
        raise
    finally:
        for container in [sidecar, name]:
            subprocess.run(['docker', 'rm', '-f', container], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        subprocess.run(['docker', 'volume', 'rm', volume], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
