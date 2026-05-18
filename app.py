from gevent import monkey
monkey.patch_all()

import os, random, string, logging, time, json, threading, socket, tempfile, shutil
from flask import Flask, jsonify, request, send_from_directory, Response, stream_with_context
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
import redis
import yt_dlp
from ytmusicapi import YTMusic
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)

CORS(app, resources={r"/*": {"origins": "*"}})

@app.before_request
def handle_preflight():
    if request.method == 'OPTIONS':
        res = app.make_default_options_response()
        res.headers['Access-Control-Allow-Origin'] = '*'
        res.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
        res.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
        res.headers['Access-Control-Max-Age'] = '86400'
        return res

@app.after_request
def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Headers'] = 'Content-Type, Authorization'
    response.headers['Access-Control-Allow-Methods'] = 'GET, POST, PUT, DELETE, OPTIONS'
    return response

app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024
app.config['SECRET_KEY'] = os.environ.get('SECRET_KEY', 'moodsync-dev-secret')

socketio = SocketIO(app,
    cors_allowed_origins="*",
    async_mode='gevent',
    ping_timeout=60,
    ping_interval=25,
    transports=['websocket', 'polling']
)

UPLOAD_FOLDER = os.path.abspath('uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# --- Cloudflare R2 Storage (optional — falls back to local disk if not configured) ---
def _r2_client():
    account_id = os.environ.get('R2_ACCOUNT_ID')
    access_key = os.environ.get('R2_ACCESS_KEY_ID')
    secret_key = os.environ.get('R2_SECRET_ACCESS_KEY')
    if not all([account_id, access_key, secret_key]):
        return None, None
    try:
        import boto3
        from botocore.client import Config
        client = boto3.client(
            's3',
            endpoint_url=f'https://{account_id}.r2.cloudflarestorage.com',
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            config=Config(signature_version='s3v4'),
            region_name='auto'
        )
        return client, os.environ.get('R2_BUCKET_NAME', 'moodsync')
    except Exception as e:
        logger.warning(f"R2 client init failed: {e}")
        return None, None

def r2_upload(local_path, filename, content_type='audio/mpeg'):
    client, bucket = _r2_client()
    if not client:
        return None
    try:
        client.upload_file(local_path, bucket, filename, ExtraArgs={'ContentType': content_type})
        public_url = os.environ.get('R2_PUBLIC_URL', '').rstrip('/')
        logger.info(f"✅ R2 upload: {filename}")
        return f"{public_url}/{filename}"
    except Exception as e:
        logger.error(f"R2 upload failed: {e}")
        return None

def r2_exists(filename):
    client, bucket = _r2_client()
    if not client: return False
    try:
        client.head_object(Bucket=bucket, Key=filename)
        return True
    except: return False

def r2_ensure_cors():
    """Allow any origin to fetch audio — runs once at startup."""
    client, bucket = _r2_client()
    if not client:
        return
    try:
        client.put_bucket_cors(
            Bucket=bucket,
            CORSConfiguration={
                'CORSRules': [{
                    'AllowedHeaders': ['*'],
                    'AllowedMethods': ['GET', 'HEAD'],
                    'AllowedOrigins': ['*'],
                    'ExposeHeaders': ['Content-Length', 'Content-Type', 'ETag'],
                    'MaxAgeSeconds': 86400,
                }]
            }
        )
        logger.info("✅ R2 CORS configured")
    except Exception as e:
        logger.warning(f"R2 CORS setup skipped: {e}")

r2_ensure_cors()

try:
    ytmusic = YTMusic(language='en')
except:
    ytmusic = None

# --- REDIS CONNECTION ---
r = None
redis_url = os.environ.get('REDIS_URL', 'redis://localhost:6379')

def _try_connect_redis():
    global r
    try:
        kwargs = dict(decode_responses=True, socket_connect_timeout=5, socket_timeout=5)
        if redis_url.startswith('rediss://'):
            kwargs['ssl_cert_reqs'] = 'none'
        client = redis.from_url(redis_url, **kwargs)
        client.ping()
        r = client
        logger.info(f"✅ Redis connected at {redis_url}")
        return True
    except Exception as e:
        logger.warning(f"⚠️ Redis connection failed: {e}")
        r = None
        return False

def _redis_reconnect_loop():
    """Background thread — keeps trying to reconnect if Redis is down."""
    while True:
        if r is None:
            _try_connect_redis()
        time.sleep(10)

# Try once at startup (non-blocking — 5s timeout max)
_try_connect_redis()

# Background reconnect thread so the app heals automatically
threading.Thread(target=_redis_reconnect_loop, daemon=True).start()

# --- Helpers ---
def safe_get(key): 
    return r.get(key) if r else None

def safe_set(key, val): 
    if r: r.set(key, val, ex=86400)

def get_file_url(filename):
    r2_public = os.environ.get('R2_PUBLIC_URL', '').rstrip('/')
    if r2_public:
        return f"{r2_public}/{filename}"
    host = request.headers.get('Host')
    protocol = 'https' if 'onrender' in (host or '') or 'moodsync' in (host or '') else 'http'
    return f"{protocol}://{host}/uploads/{filename}"

# --- Routes ---

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    response = send_from_directory(UPLOAD_FOLDER, filename)
    response.headers['Access-Control-Allow-Origin'] = '*'
    return response

@app.route('/api/audio/<path:filename>')
def proxy_audio(filename):
    """Stream audio from R2 through Flask so CORS headers are present regardless of bucket settings."""
    import requests as req
    r2_public = os.environ.get('R2_PUBLIC_URL', '').rstrip('/')
    if not r2_public:
        return serve_file(filename)
    url = f"{r2_public}/{filename}"
    range_header = request.headers.get('Range')
    headers = {'User-Agent': 'Mozilla/5.0'}
    if range_header:
        headers['Range'] = range_header
    try:
        upstream = req.get(url, headers=headers, stream=True, timeout=10)
        def generate():
            for chunk in upstream.iter_content(chunk_size=65536):
                if chunk:
                    yield chunk
        resp_headers = {
            'Content-Type': upstream.headers.get('Content-Type', 'audio/mpeg'),
            'Accept-Ranges': 'bytes',
            'Access-Control-Allow-Origin': '*',
        }
        for h in ('Content-Length', 'Content-Range'):
            if h in upstream.headers:
                resp_headers[h] = upstream.headers[h]
        return Response(stream_with_context(generate()), status=upstream.status_code, headers=resp_headers)
    except Exception as e:
        logger.error(f"Audio proxy error: {e}")
        return jsonify({'error': 'Audio unavailable'}), 502

@app.route('/generate', methods=['POST', 'OPTIONS'])
def generate():
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    if not r:
        _try_connect_redis()
        if not r: return jsonify({'error': 'DB Error: Redis is offline'}), 503
    
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): 
            break
    
    data = {
        'playlist': [], 'title': "Sonic Space", 'users': {}, 'admin_uuid': None, 'admin_sid': None,
        'current_state': {
            'isPlaying': False, 'trackIndex': 0, 'volume': 80, 
            'startTimestamp': 0, 'pausedAt': 0, 'isCollaborative': False, 'serverTime': time.time()
        }
    }
    safe_set(f"room:{code}", json.dumps(data))
    return jsonify({'room_code': code})

@app.route('/api/room/<code_in>', methods=['GET', 'OPTIONS'])
def get_room(code_in):
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    if not r: return jsonify({'error': 'DB Error'}), 500
    
    data = safe_get(f"room:{code_in.upper()}")
    resp = json.loads(data) if data else {'error': 'Not Found'}
    if 'error' not in resp: resp['serverTime'] = time.time()
    return jsonify(resp)

@app.route('/api/upload-local', methods=['POST', 'OPTIONS'])
def upload_local():
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    try:
        f = request.files['file']
        ext = os.path.splitext(f.filename)[1].lower() or '.mp3'
        name = secure_filename(f"{int(time.time())}{ext}")
        tmp_path = os.path.join(UPLOAD_FOLDER, name)
        f.save(tmp_path)
        # Try R2 first; fall back to serving from local disk
        r2_url = r2_upload(tmp_path, name, content_type=f.content_type or 'audio/mpeg')
        if r2_url:
            os.remove(tmp_path)
            return jsonify({'audioUrl': r2_url})
        return jsonify({'audioUrl': get_file_url(name)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/yt-search', methods=['POST', 'OPTIONS'])
def search_yt():
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    q = request.json.get('query', '')
    if not q:
        return jsonify({'results': []})

    api_key = os.environ.get('YOUTUBE_API_KEY')
    if api_key:
        try:
            from googleapiclient.discovery import build
            youtube = build('youtube', 'v3', developerKey=api_key)
            resp = youtube.search().list(
                part='snippet', q=q, type='video',
                videoCategoryId='10', maxResults=8
            ).execute()
            results = []
            for item in resp.get('items', []):
                vid_id = item['id'].get('videoId')
                if not vid_id:
                    continue
                snippet = item['snippet']
                results.append({
                    'id': vid_id,
                    'title': snippet['title'],
                    'artist': snippet['channelTitle'].replace(' - Topic', ''),
                    'thumbnail': snippet['thumbnails'].get('high', {}).get('url')
                               or snippet['thumbnails']['default']['url'],
                })
            return jsonify({'results': results})
        except Exception as e:
            logger.warning(f"YouTube Data API search failed: {e}")

    # Fallback: ytmusicapi (scraping-based, less reliable)
    if ytmusic:
        try:
            results = ytmusic.search(q, filter="songs", limit=5)
            return jsonify({'results': [{
                'id': i['videoId'],
                'title': i['title'],
                'artist': i['artists'][0]['name'] if 'artists' in i else 'Unknown',
                'thumbnail': i['thumbnails'][-1]['url'] if 'thumbnails' in i else None
            } for i in results if 'videoId' in i]})
        except Exception as e:
            logger.warning(f"ytmusicapi search failed: {e}")

    return jsonify({'results': [], 'error': 'Search unavailable'})

@app.route('/api/room/<code_in>/add-yt', methods=['POST', 'OPTIONS'])
def add_yt(code_in):
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    room = code_in.upper()
    data = request.json
    uuid = data.get('uuid')
    
    rd_data = safe_get(f"room:{room}")
    if not rd_data: return jsonify({'error': 'Room not found'}), 404
    rd = json.loads(rd_data)
    
    if rd.get('admin_uuid') != uuid and not rd['current_state'].get('isCollaborative'):
        return jsonify({'error': 'Permission Denied'}), 403

    try:
        vid = data['id']
        # Resolve duration if not supplied. Search results don't include it; URL-paste does.
        duration = data.get('duration')
        if not duration:
            try:
                cookies_path = _get_cookies_path()
                opts = {'quiet': True, 'skip_download': True, 'nocheckcertificate': True,
                        'extractor_args': {'youtube': {'player_client': ['tv'] if cookies_path else ['ios']}}}
                if cookies_path: opts['cookiefile'] = cookies_path
                with yt_dlp.YoutubeDL(opts) as ydl:
                    info = ydl.extract_info(f"https://www.youtube.com/watch?v={vid}", download=False)
                    duration = info.get('duration')
            except Exception as e:
                logger.warning(f"Could not resolve duration for {vid}: {e}")

        lrc = fetch_lyrics(data['title'], data.get('artist', ''))
        add_track_logic(
            room, rd, data['title'], data['artist'],
            url=None, art=data.get('thumbnail'), lyrics=lrc,
            video_id=vid, duration=duration,
        )
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"add_yt error: {e}")
        socketio.emit('status_update', {'message': "Couldn't add track", 'error': True}, to=room)
        return jsonify({'error': str(e)}), 500

@app.route('/api/room/<code_in>/add-upload', methods=['POST', 'OPTIONS'])
def add_upload_route(code_in):
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    room = code_in.upper()
    data = request.json
    rd_data = safe_get(f"room:{room}")
    if not rd_data: return jsonify({'error': 'Room not found'}), 404
    rd = json.loads(rd_data)
    add_track_logic(room, rd, data['title'], data['artist'], data['audioUrl'], None, None)
    return jsonify({'success': True})

def fetch_lyrics(title, artist=''):
    try:
        import requests as req
        resp = req.get(
            'https://lrclib.net/api/get',
            params={'track_name': title, 'artist_name': artist},
            timeout=4
        )
        if resp.ok:
            d = resp.json()
            return d.get('syncedLyrics') or d.get('plainLyrics')
    except Exception as e:
        logger.debug(f"Lyrics fetch skipped: {e}")
    return None

def add_track_logic(room_code, rd, title, artist, url, art, lyrics, video_id=None, duration=None):
    key = f"room:{room_code}"
    with r.lock(f"lock:{key}", timeout=5):
        fresh_rd = json.loads(safe_get(key))
        fresh_rd['playlist'].append({
            'name': title, 'artist': artist, 'audioUrl': url, 'albumArt': art,
            'lyrics': lyrics, 'videoId': video_id, 'duration': duration,
        })
        if len(fresh_rd['playlist']) == 1:
            start_time = time.time() + 2.0
            fresh_rd['current_state']['isPlaying'] = True
            fresh_rd['current_state']['startTimestamp'] = start_time
            fresh_rd['current_state']['serverTime'] = time.time()
            fresh_rd['current_state']['trackIndex'] = 0
        safe_set(key, json.dumps(fresh_rd))
        socketio.emit('refresh_playlist', fresh_rd, to=room_code)
        if len(fresh_rd['playlist']) == 1: 
            socketio.emit('sync_player_state', fresh_rd['current_state'], to=room_code)

def _get_cookies_path():
    """Copy secret cookies to /tmp so yt-dlp can write back to it."""
    secret = '/etc/secrets/cookies.txt'
    writable = '/tmp/yt_cookies.txt'
    if os.path.exists(secret):
        try:
            shutil.copy2(secret, writable)
            return writable
        except Exception as e:
            logger.warning(f"Could not copy cookies: {e}")
    return None

_PIPED_APIS = [
    ('https://pipedapi.kavin.rocks', 25),
    ('https://pipedapi.adminforge.de', 20),
    ('https://pipedapi.reallyaweso.me', 20),
    ('https://piped-api.projectsegfau.lt', 20),
    ('https://pipedapi.tokhmi.xyz', 20),
    ('https://piped-api.garudalinux.org', 20),
]

_INVIDIOUS_APIS = [
    ('https://inv.nadeko.net', 25),
    ('https://invidious.snopyta.org', 25),
    ('https://invidious.kavin.rocks', 25),
    ('https://invidious.flokinet.to', 20),
    ('https://vid.puffyan.us', 20),
]

def _download_stream(stream_url):
    """Download a raw audio stream URL and convert to mp3. Returns local_mp3_path or raises."""
    import requests as req, subprocess, tempfile
    with tempfile.NamedTemporaryFile(suffix='.tmp', delete=False) as tmp:
        raw_path = tmp.name
    try:
        with req.get(stream_url, stream=True, timeout=180,
                     headers={'User-Agent': 'Mozilla/5.0'}) as resp:
            resp.raise_for_status()
            with open(raw_path, 'wb') as fout:
                for chunk in resp.iter_content(chunk_size=65536):
                    fout.write(chunk)
        mp3_path = raw_path + '.mp3'
        subprocess.run(
            ['ffmpeg', '-y', '-i', raw_path, '-vn', '-acodec', 'libmp3lame', '-q:a', '2', mp3_path],
            check=True, capture_output=True
        )
        return mp3_path
    finally:
        try: os.remove(raw_path)
        except: pass

def _ytdlp_download(video_id, output_path, cookies_path):
    """Direct yt-dlp download. With cookies, uses the 'web' client; without, falls back to 'ios'."""
    dl_opts = {
        'format': 'bestaudio/best',
        'outtmpl': output_path,
        'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3'}],
        'quiet': True,
        'nocheckcertificate': True,
        'extractor_args': {'youtube': {'player_client': ['tv'] if cookies_path else ['ios']}},
    }
    if cookies_path:
        dl_opts['cookiefile'] = cookies_path
    else:
        dl_opts['no_cookies'] = True
    try:
        with yt_dlp.YoutubeDL(dl_opts) as ydl:
            ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        if os.path.exists(output_path):
            logger.info(f"✅ yt-dlp ({'cookies' if cookies_path else 'no-cookies'}) → {video_id}")
            return True
    except Exception as e:
        logger.warning(f"yt-dlp ({'cookies' if cookies_path else 'no-cookies'}) failed: {e}")
    return False

def _cobalt_download(video_id, output_path):
    """
    cobalt.tools: dedicated download service that handles YouTube bot detection.
    Returns True and writes mp3 directly to output_path on success.
    """
    import requests as req
    try:
        resp = req.post(
            'https://api.cobalt.tools/',
            json={
                'url': f'https://www.youtube.com/watch?v={video_id}',
                'downloadMode': 'audio',
                'audioFormat': 'mp3',
            },
            headers={
                'Accept': 'application/json',
                'Content-Type': 'application/json',
                'User-Agent': 'Mozilla/5.0',
            },
            timeout=30
        )
        if not resp.ok:
            logger.warning(f"cobalt.tools → {resp.status_code}: {resp.text[:200]}")
            return False
        data = resp.json()
        status = data.get('status')
        url = data.get('url')
        if status in ('tunnel', 'redirect', 'stream') and url:
            with req.get(url, stream=True, timeout=180,
                         headers={'User-Agent': 'Mozilla/5.0'}) as dl:
                dl.raise_for_status()
                with open(output_path, 'wb') as f:
                    for chunk in dl.iter_content(chunk_size=65536):
                        f.write(chunk)
            logger.info(f"✅ cobalt.tools → {status}")
            return True
        logger.warning(f"cobalt.tools → unexpected response: {data}")
    except Exception as e:
        logger.warning(f"cobalt.tools failed: {e}")
    return False

def _get_piped_audio(video_id):
    """Return stream URL from a Piped instance, or None."""
    import requests as req
    for api, timeout in _PIPED_APIS:
        try:
            r = req.get(f'{api}/streams/{video_id}', timeout=timeout,
                        headers={'User-Agent': 'Mozilla/5.0'})
            if not r.ok:
                logger.warning(f"Piped {api} → {r.status_code}")
                continue
            streams = r.json().get('audioStreams', [])
            if not streams:
                logger.warning(f"Piped {api} → no audioStreams")
                continue
            best = max(streams, key=lambda s: s.get('bitrate', 0))
            url = best.get('url', '')
            if url:
                logger.info(f"✅ Piped {api} ({best.get('mimeType','?')}, {best.get('bitrate',0)}bps)")
                return url
        except Exception as e:
            logger.warning(f"Piped {api} failed: {e}")
    return None

def _get_invidious_audio(video_id):
    """Return stream URL from an Invidious instance, or None."""
    import requests as req
    for api, timeout in _INVIDIOUS_APIS:
        try:
            r = req.get(f'{api}/api/v1/videos/{video_id}', timeout=timeout,
                        headers={'User-Agent': 'Mozilla/5.0'})
            if not r.ok:
                logger.warning(f"Invidious {api} → {r.status_code}")
                continue
            data = r.json()
            formats = [f for f in data.get('adaptiveFormats', [])
                       if 'audio' in f.get('type', '')]
            if not formats:
                logger.warning(f"Invidious {api} → no audio formats")
                continue
            best = max(formats, key=lambda f: int(f.get('bitrate', 0)))
            url = best.get('url', '')
            if url:
                logger.info(f"✅ Invidious {api} ({best.get('type','?')}, {best.get('bitrate',0)}bps)")
                return url
        except Exception as e:
            logger.warning(f"Invidious {api} failed: {e}")
    return None

def _build_cors_preflight_response():
    response = jsonify({})
    response.headers.add("Access-Control-Allow-Origin", "*")
    response.headers.add("Access-Control-Allow-Headers", "*")
    response.headers.add("Access-Control-Allow-Methods", "*")
    return response

@socketio.on('join_room')
def on_join(data):
    room = data['room_code'].upper()
    username = data.get('username', 'Guest')
    uuid = data.get('uuid')
    sid = request.sid
    join_room(room)
    
    if not r: return
    
    key = f"room:{room}"
    with r.lock(f"lock:{key}", timeout=5):
        rd_data = safe_get(key)
        if not rd_data: return
        rd = json.loads(rd_data)
        is_admin = False
        if not rd.get('admin_uuid'):
            rd['admin_uuid'] = uuid
            rd['admin_sid'] = sid
            is_admin = True
        elif rd['admin_uuid'] == uuid:
            rd['admin_sid'] = sid
            is_admin = True
        rd['users'][sid] = {'name': username, 'isAdmin': is_admin, 'uuid': uuid}
        rd['current_state']['serverTime'] = time.time()
        safe_set(key, json.dumps(rd))
        r.set(f"sid:{sid}", room, ex=86400)
        emit('role_update', {'isAdmin': is_admin}, to=sid)
        emit('load_current_state', rd['current_state'], to=sid)
        emit('update_user_list', [{'sid': k, **v} for k, v in rd['users'].items()], to=room)

@socketio.on('update_player_state')
def on_update(data):
    sid = request.sid
    room = data['room_code'].upper()
    key = f"room:{room}"
    rd_data = safe_get(key)
    if not rd_data: return
    rd = json.loads(rd_data)
    if rd.get('admin_sid') != sid and not rd['current_state'].get('isCollaborative'): return

    new_state = data['state']
    if new_state.get('isPlaying') and not rd['current_state']['isPlaying']:
        if 'startTimestamp' not in new_state: new_state['startTimestamp'] = time.time() + 1.5
    if new_state.get('isPlaying') is False:
        new_state['pausedAt'] = new_state.get('currentTime', 0)
    new_state['serverTime'] = time.time()
    rd['current_state'].update(new_state)
    safe_set(key, json.dumps(rd))
    emit('sync_player_state', rd['current_state'], to=room, include_self=False)

@socketio.on('get_server_time')
def get_server_time(data): return {'serverTime': time.time()}

@socketio.on('toggle_settings')
def on_toggle(data):
    room = data['room_code'].upper()
    key = f"room:{room}"
    rd = json.loads(safe_get(key))
    rd['current_state']['isCollaborative'] = data['value']
    safe_set(key, json.dumps(rd))
    emit('sync_player_state', rd['current_state'], to=room)

@socketio.on('remove_track')
def on_remove_track(data):
    sid = request.sid
    room = data['room_code'].upper()
    key = f"room:{room}"
    with r.lock(f"lock:{key}", timeout=5):
        rd_data = safe_get(key)
        if not rd_data: return
        rd = json.loads(rd_data)
        if rd.get('admin_sid') != sid and not rd['current_state'].get('isCollaborative'):
            return
        idx = data.get('track_index', -1)
        playlist = rd.get('playlist', [])
        if idx < 0 or idx >= len(playlist):
            return
        playlist.pop(idx)
        current = rd['current_state'].get('trackIndex', 0)
        if idx < current:
            rd['current_state']['trackIndex'] = max(0, current - 1)
        elif idx == current:
            rd['current_state']['trackIndex'] = min(current, len(playlist) - 1) if playlist else 0
            if not playlist:
                rd['current_state']['isPlaying'] = False
        rd['playlist'] = playlist
        safe_set(key, json.dumps(rd))
        emit('refresh_playlist', rd, to=room)
        emit('sync_player_state', rd['current_state'], to=room)

@socketio.on('transfer_admin')
def on_transfer_admin(data):
    sid = request.sid
    room = data['room_code'].upper()
    key = f"room:{room}"
    new_sid = data.get('new_sid')
    with r.lock(f"lock:{key}", timeout=5):
        rd_data = safe_get(key)
        if not rd_data: return
        rd = json.loads(rd_data)
        if rd.get('admin_sid') != sid: return
        if new_sid not in rd['users']: return
        new_uuid = rd['users'][new_sid].get('uuid')
        rd['admin_sid'] = new_sid
        rd['admin_uuid'] = new_uuid
        for s, u in rd['users'].items():
            u['isAdmin'] = (s == new_sid)
        safe_set(key, json.dumps(rd))
        emit('role_update', {'isAdmin': False}, to=sid)
        emit('role_update', {'isAdmin': True}, to=new_sid)
        emit('admin_transferred', {'new_admin_uuid': new_uuid}, to=room)
        emit('update_user_list', [{'sid': k, **v} for k, v in rd['users'].items()], to=room)

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    if not r: return
    room = r.get(f"sid:{sid}")
    if not room: return
    r.delete(f"sid:{sid}")
    key = f"room:{room}"
    try:
        with r.lock(f"lock:{key}", timeout=5):
            data = safe_get(key)
            if data:
                rd = json.loads(data)
                if sid in rd['users']:
                    del rd['users'][sid]
                    safe_set(key, json.dumps(rd))
                    emit('update_user_list', [{'sid': k, **v} for k, v in rd['users'].items()], to=room)
    except: pass

@app.route('/api/lyrics', methods=['GET', 'OPTIONS'])
def get_lyrics():
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    title = request.args.get('title', '')
    artist = request.args.get('artist', '')
    if not title:
        return jsonify({'lrc': None})
    try:
        import requests as req
        resp = req.get(
            'https://lrclib.net/api/get',
            params={'track_name': title, 'artist_name': artist},
            timeout=5
        )
        if resp.ok:
            d = resp.json()
            return jsonify({'lrc': d.get('syncedLyrics') or d.get('plainLyrics')})
    except Exception as e:
        logger.warning(f"Lyrics fetch failed: {e}")
    return jsonify({'lrc': None})

@app.route('/api/yt-info', methods=['POST', 'OPTIONS'])
def yt_info():
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    url = request.json.get('url', '')
    try:
        cookies_path = _get_cookies_path()
        opts = {
            'quiet': True, 'skip_download': True, 'nocheckcertificate': True,
            'extractor_args': {'youtube': {'player_client': ['tv'] if cookies_path else ['ios']}},
        }
        if cookies_path:
            opts['cookiefile'] = cookies_path
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
            return jsonify({
                'id': info.get('id'),
                'title': info.get('title'),
                'artist': info.get('uploader', 'Unknown').replace(' - Topic', ''),
                'thumbnail': info.get('thumbnail'),
                'duration': info.get('duration'),
            })
    except Exception as e:
        return jsonify({'error': str(e)}), 400

if __name__ == '__main__':
    port = int(os.environ.get('PORT', 5001))
    socketio.run(app, host='0.0.0.0', port=port)