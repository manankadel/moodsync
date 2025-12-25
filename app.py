import eventlet
eventlet.monkey_patch() # MUST BE FIRST

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

# Setup
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024 # 100MB

# CORS & Socket
CORS(app, resources={r"/*": {"origins": "*"}})
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet', ping_timeout=60)

# Storage
UPLOAD_FOLDER = os.path.abspath('uploads')
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# APIs
ytmusic = YTMusic()

# Redis Connection
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
    # Generates a bulletproof URL
    host = request.headers.get('Host')
    protocol = 'https' if 'onrender' in host else 'http'
    return f"{protocol}://{host}/uploads/{filename}"

# --- ROUTES ---

@app.route('/ping')
def ping(): return jsonify({'status': 'ok'})

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    # Enable streaming/seeking
    response = send_from_directory(UPLOAD_FOLDER, filename)
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Accept-Ranges'] = 'bytes'
    return response

@app.route('/generate', methods=['POST'])
def generate():
    if not r: return jsonify({'error': 'Server Error'}), 500
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): break
    
    data = {'playlist': [], 'title': "Sonic Space", 'users': {}, 'current_state': {'isPlaying': False, 'trackIndex': 0, 'volume': 80}}
    safe_set(f"room:{code}", json.dumps(data))
    return jsonify({'room_code': code})

@app.route('/api/room/<code_in>')
def get_room(code_in):
    if not r: return jsonify({'error': 'Server Error'}), 500
    data = safe_get(f"room:{code_in.upper()}")
    return jsonify(json.loads(data) if data else {'error': 'Not Found'})

@app.route('/api/upload-local', methods=['POST'])
def upload_local():
    try:
        f = request.files['file']
        clean_name = secure_filename(f"{int(time.time())}_{f.filename}")
        f.save(os.path.join(UPLOAD_FOLDER, clean_name))
        return jsonify({'audioUrl': get_file_url(clean_name)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/yt-search', methods=['POST'])
def search_yt():
    q = request.json.get('query')
    try:
        # Use YTMusic - No keys, no blocks
        results = ytmusic.search(q, filter="songs", limit=5)
        clean_results = []
        for item in results:
            clean_results.append({
                'id': item['videoId'],
                'title': item['title'],
                'artist': item['artists'][0]['name'],
                'thumbnail': item['thumbnails'][-1]['url']
            })
        return jsonify({'results': clean_results})
    except Exception as e:
        logger.error(f"Search Error: {e}")
        return jsonify({'results': []})

@app.route('/api/room/<code_in>/add-yt', methods=['POST'])
def add_yt(code_in):
    data = request.json
    vid = data['id']
    filename = f"{vid}.mp3"
    path = os.path.join(UPLOAD_FOLDER, filename)
    
    # Download if missing
    if not os.path.exists(path):
        try:
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': path,
                'postprocessors': [{'key': 'FFmpegExtractAudio','preferredcodec': 'mp3'}],
                'quiet': True,
                'extractor_args': {'youtube': {'player_client': ['ios']}} # Spoof iOS
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl: ydl.download([f"https://www.youtube.com/watch?v={vid}"])
        except Exception as e:
            return jsonify({'error': 'Download blocked'}), 500

    # Get Lyrics
    lyrics = None
    try: lyrics = syncedlyrics.search(f"{data['title']} {data['artist']}")
    except: pass

    # Add to Room
    add_track(code_in, data['title'], data['artist'], get_file_url(filename), data['thumbnail'], lyrics)
    return jsonify({'success': True})

@app.route('/api/room/<code_in>/add-upload', methods=['POST'])
def add_upload_route(code_in):
    data = request.json
    add_track(code_in, data['title'], data['artist'], data['audioUrl'], None, None)
    return jsonify({'success': True})

def add_track(room_code, title, artist, url, art, lyrics):
    key = f"room:{room_code.upper()}"
    with r.lock(f"lock:{key}", timeout=5):
        rd = json.loads(safe_get(key))
        rd['playlist'].append({'name': title, 'artist': artist, 'audioUrl': url, 'albumArt': art, 'lyrics': lyrics})
        if len(rd['playlist']) == 1: rd['current_state']['isPlaying'] = True
        safe_set(key, json.dumps(rd))
        socketio.emit('refresh_playlist', rd, to=room_code.upper())
        if len(rd['playlist']) == 1: socketio.emit('sync_player_state', rd['current_state'], to=room_code.upper())

# --- SOCKET ---
@socketio.on('join_room')
def on_join(data):
    room = data['room_code'].upper()
    join_room(room)
    rd = json.loads(safe_get(f"room:{room}"))
    sid = request.sid
    if not rd.get('admin_sid'): rd['admin_sid'] = sid
    rd['users'][sid] = {'name': data.get('username'), 'isAdmin': rd['admin_sid'] == sid}
    safe_set(f"room:{room}", json.dumps(rd))
    emit('load_current_state', rd['current_state'])
    emit('update_user_list', list(rd['users'].values()), to=room)

@socketio.on('update_player_state')
def on_update(data):
    room = data['room_code'].upper()
    rd = json.loads(safe_get(f"room:{room}"))
    rd['current_state'].update(data['state'])
    safe_set(f"room:{room}", json.dumps(rd))
    emit('sync_player_state', data['state'], to=room, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001)