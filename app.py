import eventlet
eventlet.monkey_patch()

import os, random, string, logging, time, json, threading
from flask import Flask, jsonify, request, send_from_directory
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

# FIX 1: Allow CORS for your custom domain and Vercel
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True)

# FIX 2: ProxyFix is needed for Render to handle https correctly
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024
app.config['SECRET_KEY'] = 'moodsync-secret-key'

# FIX 3: SocketIO Configuration for Cloud Latency
socketio = SocketIO(app, 
    cors_allowed_origins="*", 
    async_mode='eventlet', 
    ping_timeout=60, 
    ping_interval=25,
    transports=['websocket', 'polling']
)

UPLOAD_FOLDER = os.path.abspath('uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Initialize Clients
try:
    ytmusic = YTMusic(language='en')
except:
    ytmusic = None

try:
    r = redis.from_url(os.environ.get('REDIS_URL', 'redis://localhost:6379'), decode_responses=True)
    r.ping()
    logger.info("✅ Redis Online")
except:
    logger.error("❌ Redis Offline")
    r = None

# --- Helpers ---
def safe_get(key): 
    return r.get(key) if r else None

def safe_set(key, val): 
    if r: r.set(key, val, ex=86400) # 24h expiry

def get_file_url(filename):
    host = request.headers.get('Host')
    protocol = 'https' if 'onrender' in host or 'moodsync' in host else 'http'
    return f"{protocol}://{host}/uploads/{filename}"

# --- Routes ---

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    response = send_from_directory(UPLOAD_FOLDER, filename)
    # Ensure browsers can play the audio cross-origin
    response.headers['Access-Control-Allow-Origin'] = '*'
    return response

@app.route('/generate', methods=['POST', 'OPTIONS'])
def generate():
    if request.method == 'OPTIONS':
        return _build_cors_preflight_response()
        
    if not r: 
        return jsonify({'error': 'DB Error'}), 500
    
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): 
            break
    
    data = {
        'playlist': [], 
        'title': "Sonic Space", 
        'users': {}, 
        'admin_uuid': None,
        'admin_sid': None,
        'current_state': {
            'isPlaying': False, 
            'trackIndex': 0, 
            'volume': 80, 
            'startTimestamp': 0,
            'pausedAt': 0, 
            'isCollaborative': False,
            'serverTime': time.time()
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
    
    if 'error' not in resp: 
        resp['serverTime'] = time.time()
    
    return jsonify(resp)

@app.route('/api/upload-local', methods=['POST', 'OPTIONS'])
def upload_local():
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    try:
        f = request.files['file']
        name = secure_filename(f"{int(time.time())}_{f.filename}")
        f.save(os.path.join(UPLOAD_FOLDER, name))
        return jsonify({'audioUrl': get_file_url(name)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/yt-search', methods=['POST', 'OPTIONS'])
def search_yt():
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    q = request.json.get('query')
    try:
        results = ytmusic.search(q, filter="songs", limit=5)
        return jsonify({'results': [{
            'id': i['videoId'], 
            'title': i['title'], 
            'artist': i['artists'][0]['name'] if 'artists' in i else 'Unknown', 
            'thumbnail': i['thumbnails'][-1]['url'] if 'thumbnails' in i else None
        } for i in results if 'videoId' in i]})
    except:
        return jsonify({'results': [], 'error': 'Search failed'})

@app.route('/api/room/<code_in>/add-yt', methods=['POST', 'OPTIONS'])
def add_yt(code_in):
    if request.method == 'OPTIONS': return _build_cors_preflight_response()
    
    room = code_in.upper()
    data = request.json
    uuid = data.get('uuid')
    
    # Permission Check
    rd_data = safe_get(f"room:{room}")
    if not rd_data: return jsonify({'error': 'Room not found'}), 404
    rd = json.loads(rd_data)
    
    if rd.get('admin_uuid') != uuid and not rd['current_state'].get('isCollaborative'):
        return jsonify({'error': 'Permission Denied'}), 403

    socketio.emit('status_update', {'message': f"Downloading {data['title']}..."}, to=room)
    
    try:
        vid = data['id']
        filename = f"{vid}.mp3"
        path = os.path.join(UPLOAD_FOLDER, filename)
        
        if not os.path.exists(path):
            # FIX 4: Robust YouTube Downloader Options
            opts = {
                'format': 'bestaudio/best',
                'outtmpl': path,
                'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3'}],
                'quiet': True,
                'nocheckcertificate': True,
                # Use 'android' client to bypass "Sign in to confirm you're not a bot"
                'extractor_args': {
                    'youtube': {
                        'player_client': ['android', 'web']
                    }
                }
            }
            with yt_dlp.YoutubeDL(opts) as ydl: 
                ydl.download([f"https://www.youtube.com/watch?v={vid}"])
        
        add_track_logic(room, rd, data['title'], data['artist'], get_file_url(filename), data['thumbnail'], None)
        socketio.emit('status_update', {'message': None}, to=room) 
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"Download Error: {e}")
        socketio.emit('status_update', {'message': "Download failed", 'error': True}, to=room)
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

def add_track_logic(room_code, rd, title, artist, url, art, lyrics):
    key = f"room:{room_code}"
    
    # We use a Lock to prevent race conditions on playlist array
    with r.lock(f"lock:{key}", timeout=5):
        fresh_rd = json.loads(safe_get(key))
        fresh_rd['playlist'].append({
            'name': title, 
            'artist': artist, 
            'audioUrl': url, 
            'albumArt': art, 
            'lyrics': lyrics
        })
        
        # If it's the first song, schedule it to play in 2 seconds
        if len(fresh_rd['playlist']) == 1:
            start_time = time.time() + 2.0
            fresh_rd['current_state']['isPlaying'] = True
            fresh_rd['current_state']['startTimestamp'] = start_time
            fresh_rd['current_state']['serverTime'] = time.time()
            # Also reset track index
            fresh_rd['current_state']['trackIndex'] = 0
        
        safe_set(key, json.dumps(fresh_rd))
        socketio.emit('refresh_playlist', fresh_rd, to=room_code)
        
        if len(fresh_rd['playlist']) == 1: 
            socketio.emit('sync_player_state', fresh_rd['current_state'], to=room_code)

def _build_cors_preflight_response():
    response = jsonify({})
    response.headers.add("Access-Control-Allow-Origin", "*")
    response.headers.add("Access-Control-Allow-Headers", "*")
    response.headers.add("Access-Control-Allow-Methods", "*")
    return response

# --- Socket Events ---

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
    
    # PRODUCTION SYNC LOGIC
    # If starting to play, schedule it in the future
    if new_state.get('isPlaying') and not rd['current_state']['isPlaying']:
        if 'startTimestamp' not in new_state: # If client didn't provide one
             new_state['startTimestamp'] = time.time() + 1.5 # 1.5s Buffer
    
    # If pausing, record exactly where we paused
    if new_state.get('isPlaying') is False:
        new_state['pausedAt'] = new_state.get('currentTime', 0)

    new_state['serverTime'] = time.time()
    rd['current_state'].update(new_state)
    safe_set(key, json.dumps(rd))
    emit('sync_player_state', rd['current_state'], to=room, include_self=False)

@socketio.on('get_server_time')
def get_server_time(data):
    return {'serverTime': time.time()}

@socketio.on('toggle_settings')
def on_toggle(data):
    room = data['room_code'].upper()
    key = f"room:{room}"
    rd = json.loads(safe_get(key))
    rd['current_state']['isCollaborative'] = data['value']
    safe_set(key, json.dumps(rd))
    emit('sync_player_state', rd['current_state'], to=room)

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    if not r: return
    room = r.get(f"sid:{sid}")
    if not room: return
    r.delete(f"sid:{sid}")
    
    key = f"room:{room}"
    # Use lock to avoid corruption during frequent disconnects
    try:
        with r.lock(f"lock:{key}", timeout=5):
            data = safe_get(key)
            if data:
                rd = json.loads(data)
                if sid in rd['users']:
                    del rd['users'][sid]
                    safe_set(key, json.dumps(rd))
                    emit('update_user_list', [{'sid': k, **v} for k, v in rd['users'].items()], to=room)
    except:
        pass

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001)