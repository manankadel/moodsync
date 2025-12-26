import eventlet
eventlet.monkey_patch()

import os, random, string, logging, time, json
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
import redis
import yt_dlp
from ytmusicapi import YTMusic
import syncedlyrics
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024

CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet', ping_timeout=60)

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

def safe_get(key): return r.get(key) if r else None
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
    if not r: return jsonify({'error': 'DB Error'}), 500
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): break
    
    data = {
        'playlist': [], 
        'title': "Sonic Space", 
        'users': {}, 
        'current_state': {
            'isPlaying': False, 'trackIndex': 0, 'volume': 80, 
            'startTimestamp': 0, 'pausedAt': 0
        }
    }
    safe_set(f"room:{code}", json.dumps(data))
    return jsonify({'room_code': code})

@app.route('/api/room/<code_in>')
def get_room(code_in):
    if not r: return jsonify({'error': 'DB Error'}), 500
    data = safe_get(f"room:{code_in.upper()}")
    resp = json.loads(data) if data else {'error': 'Not Found'}
    # Send server time for initial offset calc
    if 'error' not in resp: resp['serverTime'] = time.time()
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
            'artist': i['artists'][0]['name'], 
            'thumbnail': i['thumbnails'][-1]['url']
        } for i in results if 'videoId' in i]})
    except:
        return jsonify({'results': [], 'error': 'Search failed'})

@app.route('/api/room/<code_in>/add-yt', methods=['POST'])
def add_yt(code_in):
    room_code = code_in.upper()
    socketio.emit('status_update', {'message': f"Downloading..."}, to=room_code)
    
    try:
        data = request.json
        vid = data['id']
        filename = f"{vid}.mp3"
        path = os.path.join(UPLOAD_FOLDER, filename)
        
        if not os.path.exists(path):
            opts = {
                'format': 'bestaudio/best', 'outtmpl': path, 
                'postprocessors': [{'key': 'FFmpegExtractAudio','preferredcodec': 'mp3'}],
                'quiet': True, 'nocheckcertificate': True,
                'extractor_args': {'youtube': {'player_client': ['ios']}}
            }
            with yt_dlp.YoutubeDL(opts) as ydl: ydl.download([f"https://www.youtube.com/watch?v={vid}"])
        
        add_track(room_code, data['title'], data['artist'], get_file_url(filename), data['thumbnail'])
        socketio.emit('status_update', {'message': None}, to=room_code) 
        return jsonify({'success': True})
    except Exception as e:
        socketio.emit('status_update', {'message': "Download failed", 'error': True}, to=room_code)
        return jsonify({'error': 'Download blocked'}), 500

@app.route('/api/room/<code_in>/add-upload', methods=['POST'])
def add_upload_route(code_in):
    data = request.json
    add_track(code_in.upper(), data['title'], data['artist'], data['audioUrl'], None)
    return jsonify({'success': True})

def add_track(room_code, title, artist, url, art):
    key = f"room:{room_code}"
    if not r: return
    with r.lock(f"lock:{key}", timeout=5):
        rd = json.loads(safe_get(key))
        rd['playlist'].append({'name': title, 'artist': artist, 'audioUrl': url, 'albumArt': art, 'lyrics': None})
        
        # Auto-play if first
        if len(rd['playlist']) == 1:
            rd['current_state']['isPlaying'] = True
            rd['current_state']['startTimestamp'] = time.time()
            rd['current_state']['serverTime'] = time.time()
            
        safe_set(key, json.dumps(rd))
        socketio.emit('refresh_playlist', rd, to=room_code)
        if len(rd['playlist']) == 1: socketio.emit('sync_player_state', rd['current_state'], to=room_code)

@socketio.on('join_room')
def on_join(data):
    room = data['room_code'].upper()
    join_room(room)
    if not r: return
    rd = json.loads(safe_get(f"room:{room}"))
    sid = request.sid
    if not rd.get('admin_sid'): rd['admin_sid'] = sid
    rd['users'][sid] = {'name': data.get('username'), 'isAdmin': rd['admin_sid'] == sid}
    safe_set(f"room:{room}", json.dumps(rd))
    emit('load_current_state', rd['current_state'])
    emit('update_user_list', list(rd['users'].values()), to=room)

@socketio.on('update_player_state')
def on_update(data):
    if not r: return
    room = data['room_code'].upper()
    rd = json.loads(safe_get(f"room:{room}"))
    new_state = data['state']
    
    # === PRECISE START TIMESTAMP LOGIC ===
    # If playing, calculate exactly when the song 'started' relative to server time
    if new_state.get('isPlaying'):
        if not rd['current_state']['isPlaying']:
            # Resuming from Pause
            paused_at = new_state.get('pausedAt', rd['current_state'].get('pausedAt', 0))
            new_state['startTimestamp'] = time.time() - paused_at
        elif 'currentTime' in new_state:
            # Seeking
            new_state['startTimestamp'] = time.time() - new_state['currentTime']
    
    # If pausing, save the position
    if new_state.get('isPlaying') is False:
        new_state['pausedAt'] = new_state.get('currentTime', 0)

    rd['current_state'].update(new_state)
    
    # Inject current Server Time so clients can sync clocks
    rd['current_state']['serverTime'] = time.time()
    
    safe_set(f"room:{room}", json.dumps(rd))
    emit('sync_player_state', rd['current_state'], to=room, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001)