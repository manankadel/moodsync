# FILE 1: app.py
# Location: /path/to/moodsync/app.py
# Copy ALL of this and replace your current app.py

import eventlet
eventlet.monkey_patch()

import os, random, string, logging, time, json, threading
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, join_room, emit, rooms
from flask_cors import CORS
import redis
import yt_dlp
from ytmusicapi import YTMusic
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix
import syncedlyrics

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

# ALLOW ALL ORIGINS FOR VERCEL
CORS(app, resources={r"/*": {"origins": "*"}})

# Increase ping timeout for mobile networks (4G/5G)
socketio = SocketIO(app, 
    cors_allowed_origins="*", 
    async_mode='eventlet', 
    ping_timeout=90, 
    ping_interval=25,
    transports=['websocket', 'polling'] 
)

UPLOAD_FOLDER = os.path.abspath('uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

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

def safe_get(key): 
    return r.get(key) if r else None

def safe_set(key, val): 
    if r: r.set(key, val, ex=86400)

def get_file_url(filename):
    host = request.headers.get('Host')
    protocol = 'https' if 'onrender' in host else 'http'
    return f"{protocol}://{host}/uploads/{filename}"

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    response = send_from_directory(UPLOAD_FOLDER, filename)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Accept-Ranges'] = 'bytes'
    return response

@app.route('/generate', methods=['POST'])
def generate():
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

@app.route('/api/room/<code_in>')
def get_room(code_in):
    if not r: 
        return jsonify({'error': 'DB Error'}), 500
    
    data = safe_get(f"room:{code_in.upper()}")
    resp = json.loads(data) if data else {'error': 'Not Found'}
    
    if 'error' not in resp: 
        resp['serverTime'] = time.time()
    
    return jsonify(resp)

@app.route('/api/upload-local', methods=['POST'])
def upload_local():
    try:
        f = request.files['file']
        name = secure_filename(f"{int(time.time())}_{f.filename}")
        f.save(os.path.join(UPLOAD_FOLDER, name))
        return jsonify({'audioUrl': get_file_url(name)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/yt-search', methods=['POST'])
def search_yt():
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

def check_permission(room, uuid):
    data = safe_get(f"room:{room}")
    if not data: 
        return False, None
    
    rd = json.loads(data)
    
    if rd.get('admin_uuid') == uuid or rd['current_state'].get('isCollaborative'):
        return True, rd
    
    return False, None

@app.route('/api/room/<code_in>/add-yt', methods=['POST'])
def add_yt(code_in):
    room = code_in.upper()
    data = request.json
    uuid = data.get('uuid')
    
    allowed, rd = check_permission(room, uuid)
    if not allowed: 
        return jsonify({'error': 'Permission Denied'}), 403

    socketio.emit('status_update', {'message': f"Downloading {data['title']}..."}, to=room)
    try:
        vid = data['id']
        filename = f"{vid}.mp3"
        path = os.path.join(UPLOAD_FOLDER, filename)
        
        if not os.path.exists(path):
            opts = {
                'format': 'bestaudio/best', 
                'outtmpl': path, 
                'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3'}],
                'quiet': True, 
                'nocheckcertificate': True,
                'extractor_args': {'youtube': {'player_client': ['ios']}}
            }
            with yt_dlp.YoutubeDL(opts) as ydl: 
                ydl.download([f"https://www.youtube.com/watch?v={vid}"])
        
        add_track_logic(room, rd, data['title'], data['artist'], get_file_url(filename), data['thumbnail'], None)
        socketio.emit('status_update', {'message': None}, to=room) 
        return jsonify({'success': True})
    except:
        socketio.emit('status_update', {'message': "Download failed", 'error': True}, to=room)
        return jsonify({'error': 'Download blocked'}), 500

@app.route('/api/room/<code_in>/add-upload', methods=['POST'])
def add_upload_route(code_in):
    room = code_in.upper()
    data = request.json
    uuid = data.get('uuid')
    
    allowed, rd = check_permission(room, uuid)
    if not allowed: 
        return jsonify({'error': 'Permission Denied'}), 403

    add_track_logic(room, rd, data['title'], data['artist'], data['audioUrl'], None, None)
    return jsonify({'success': True})

def add_track_logic(room_code, rd, title, artist, url, art, lyrics):
    key = f"room:{room_code}"
    
    with r.lock(f"lock:{key}", timeout=5):
        fresh_rd = json.loads(safe_get(key))
        fresh_rd['playlist'].append({
            'name': title, 
            'artist': artist, 
            'audioUrl': url, 
            'albumArt': art, 
            'lyrics': lyrics
        })
        
        if len(fresh_rd['playlist']) == 1:
            fresh_rd['current_state']['isPlaying'] = True
            fresh_rd['current_state']['startTimestamp'] = time.time()
            fresh_rd['current_state']['serverTime'] = time.time()
        
        safe_set(key, json.dumps(fresh_rd))
        socketio.emit('refresh_playlist', fresh_rd, to=room_code)
        if len(fresh_rd['playlist']) == 1: 
            socketio.emit('sync_player_state', fresh_rd['current_state'], to=room_code)

@socketio.on('join_room')
def on_join(data):
    room = data['room_code'].upper()
    username = data.get('username', 'Guest')
    uuid = data.get('uuid')
    sid = request.sid
    join_room(room)
    
    if not r: 
        return
    
    key = f"room:{room}"
    
    with r.lock(f"lock:{key}", timeout=5):
        rd = json.loads(safe_get(key) or '{}')
        if not rd: 
            return
        
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
        
        user_list = [{'sid': k, **v} for k, v in rd['users'].items()]
        emit('update_user_list', user_list, to=room)

@socketio.on('update_player_state')
def on_update(data):
    sid = request.sid
    room = data['room_code'].upper()
    key = f"room:{room}"
    rd = json.loads(safe_get(key))
    
    if rd.get('admin_sid') != sid: 
        return

    new_state = data['state']
    
    if new_state.get('isPlaying'):
        if not rd['current_state']['isPlaying']:
            paused_at = new_state.get('pausedAt', rd['current_state'].get('pausedAt', 0))
            new_state['startTimestamp'] = time.time() - paused_at
        elif 'currentTime' in new_state:
            new_state['startTimestamp'] = time.time() - new_state['currentTime']
    
    if new_state.get('isPlaying') is False:
        new_state['pausedAt'] = new_state.get('currentTime', 0)

    new_state['serverTime'] = time.time()
    rd['current_state'].update(new_state)
    safe_set(key, json.dumps(rd))
    emit('sync_player_state', rd['current_state'], to=room, include_self=False)

@socketio.on('toggle_settings')
def on_toggle(data):
    sid = request.sid
    room = data['room_code'].upper()
    key = f"room:{room}"
    rd = json.loads(safe_get(key))
    
    if rd.get('admin_sid') == sid:
        rd['current_state']['isCollaborative'] = data['value']
        rd['current_state']['serverTime'] = time.time()
        safe_set(key, json.dumps(rd))
        emit('sync_player_state', rd['current_state'], to=room)

@socketio.on('disconnect')
def on_disconnect():
    sid = request.sid
    if not r: 
        return
    
    room = r.get(f"sid:{sid}")
    if not room: 
        return
    
    r.delete(f"sid:{sid}")
    
    key = f"room:{room}"
    with r.lock(f"lock:{key}", timeout=5):
        data = safe_get(key)
        if not data: 
            return
        
        rd = json.loads(data)
        
        if sid in rd['users']:
            del rd['users'][sid]
            safe_set(key, json.dumps(rd))
            user_list = [{'sid': k, **v} for k, v in rd['users'].items()]
            emit('update_user_list', user_list, to=room)

def sync_heartbeat():
    """Emit sync pulses to all active rooms every 300ms"""
    while True:
        try:
            eventlet.sleep(0.3)
            
            if not r:
                continue
            
            cursor = 0
            while True:
                cursor, keys = r.scan(cursor, match='room:*', count=100)
                
                for key in keys:
                    try:
                        data = safe_get(key)
                        if not data:
                            continue
                        
                        rd = json.loads(data)
                        room_code = key.split(':')[1]
                        
                        state = rd.get('current_state', {})
                        state['serverTime'] = time.time()
                        
                        socketio.emit('sync_heartbeat', state, to=room_code, skip_sid=None)
                    except Exception as e:
                        logger.error(f"Heartbeat error for {key}: {e}")
                
                if cursor == 0:
                    break
        except Exception as e:
            logger.error(f"Heartbeat thread error: {e}")
            eventlet.sleep(1)

heartbeat_thread = threading.Thread(target=sync_heartbeat, daemon=True)
heartbeat_thread.start()

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001)