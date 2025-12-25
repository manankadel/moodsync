# --- CRITICAL STARTUP ---
import eventlet
eventlet.monkey_patch()

import os, random, string, logging, time, json, traceback
from flask import Flask, jsonify, request, send_file
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
import redis
import yt_dlp
import syncedlyrics
from googleapiclient.discovery import build
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

# --- LOGGING ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# --- CONFIG ---
app.config['MAX_CONTENT_LENGTH'] = 100 * 1024 * 1024
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet', ping_timeout=60)

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# --- REDIS ---
r = None
try:
    redis_url = os.getenv('REDIS_URL', 'redis://localhost:6379')
    r = redis.from_url(redis_url, decode_responses=True)
    r.ping()
    logger.info("✅ Redis Connected")
except Exception as e:
    logger.error(f"❌ Redis Offline: {e}")

YOUTUBE_API_KEY = os.getenv('YOUTUBE_API_KEY')
youtube_client = build('youtube', 'v3', developerKey=YOUTUBE_API_KEY) if YOUTUBE_API_KEY else None

def safe_get(key): return r.get(key) if r else None
def safe_set(key, value, ex=86400): 
    if r: r.set(key, value, ex=ex)

def get_secure_url(filename):
    host = request.headers.get('Host')
    scheme = 'https' if 'onrender.com' in host else request.scheme
    return f"{scheme}://{host}/uploads/{filename}"

# --- ROUTES ---

@app.route('/uploads/<path:filename>')
def serve_file_stream(filename):
    path = os.path.join(os.path.abspath(UPLOAD_FOLDER), filename)
    if not os.path.exists(path):
        return jsonify({'error': 'File not found'}), 404
    return send_file(path, conditional=True)

@app.route('/generate', methods=['POST'])
def generate():
    if not r: return jsonify({'error': 'Database connecting...'}), 503
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): break
    safe_set(f"room:{code}", json.dumps({'playlist': [], 'title': "Sonic Space", 'users': {}, 'current_state': {'isPlaying': False, 'trackIndex': 0, 'volume': 80}}))
    return jsonify({'room_code': code})

@app.route('/api/room/<code_in>')
def get_room(code_in):
    if not r: return jsonify({'error': 'Database connecting...'}), 503
    data = safe_get(f"room:{code_in.upper()}")
    return jsonify(json.loads(data) if data else {'error': 'Room not found'})

@app.route('/api/upload-local', methods=['POST'])
def upload_local():
    try:
        file = request.files['file']
        filename = secure_filename(f"{int(time.time())}_{file.filename}")
        file.save(os.path.join(UPLOAD_FOLDER, filename))
        return jsonify({'audioUrl': get_secure_url(filename)})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/yt-search', methods=['POST'])
def search_yt():
    q = request.json.get('query')
    if youtube_client:
        try:
            res = youtube_client.search().list(q=q, part="snippet", maxResults=5, type="video").execute()
            return jsonify({'results': [{'id': i['id']['videoId'], 'title': i['snippet']['title'], 'artist': i['snippet']['channelTitle'], 'thumbnail': i['snippet']['thumbnails']['high']['url']} for i in res['items']]})
        except: pass
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'default_search': 'ytsearch5', 'noplaylist': True}) as ydl:
            info = ydl.extract_info(q, download=False)
            return jsonify({'results': [{'id': e['id'], 'title': e['title'], 'artist': e.get('uploader', 'Unknown'), 'thumbnail': e.get('thumbnail')} for e in info['entries']]})
    except: 
        return jsonify({'results': []})

@app.route('/api/room/<room_code>/add-yt', methods=['POST'])
def add_yt(room_code):
    try:
        data = request.json
        v_id = data['id']
        filename = f"{v_id}.mp3"
        path = os.path.join(UPLOAD_FOLDER, filename)
        
        if not os.path.exists(path):
            opts = {
                'format': 'bestaudio/best', 
                'outtmpl': path, 
                'postprocessors': [{'key': 'FFmpegExtractAudio','preferredcodec': 'mp3'}], 
                'quiet': True,
                'extractor_args': {'youtube': {'player_client': ['ios']}}
            }
            with yt_dlp.YoutubeDL(opts) as ydl: ydl.download([f"https://www.youtube.com/watch?v={v_id}"])
        
        url = get_secure_url(filename)
        add_to_playlist(room_code, data['title'], data['artist'], url, data['thumbnail'], is_upload=False)
        return jsonify({'success': True})
    except Exception as e:
        logger.error(f"YT Download Error: {e}")
        return jsonify({'error': 'YouTube Blocked. Please use "Upload File".'}), 200

@app.route('/api/room/<room_code>/add-upload', methods=['POST'])
def add_up(room_code):
    data = request.json
    add_to_playlist(room_code, data['title'], data['artist'], data['audioUrl'], None, is_upload=True)
    return jsonify({'success': True})

def add_to_playlist(room_code, title, artist, url, art, is_upload):
    if not r: return
    room_key = f"room:{room_code.upper()}"
    with r.lock(f"lock:{room_key}", timeout=5):
        rd = json.loads(safe_get(room_key))
        rd['playlist'].append({'name': title, 'artist': artist, 'audioUrl': url, 'albumArt': art, 'isUpload': is_upload})
        if len(rd['playlist']) == 1: rd['current_state']['isPlaying'] = True
        safe_set(room_key, json.dumps(rd))
        socketio.emit('refresh_playlist', rd, to=room_code.upper())
        if len(rd['playlist']) == 1: socketio.emit('sync_player_state', rd['current_state'], to=room_code.upper())

@socketio.on('join_room')
def on_join(data):
    if not r: return
    room = data['room_code'].upper()
    join_room(room)
    sid = request.sid
    rd_json = safe_get(f"room:{room}")
    if not rd_json: return
    rd = json.loads(rd_json)
    
    is_admin = not rd.get('admin_sid')
    if is_admin: rd['admin_sid'] = sid
    rd['users'][sid] = {'name': data.get('username'), 'isAdmin': is_admin}
    
    safe_set(f"room:{room}", json.dumps(rd))
    emit('load_current_state', rd['current_state'])
    emit('update_user_list', list(rd['users'].values()), to=room)

@socketio.on('update_player_state')
def on_state(data):
    if not r: return
    room = data['room_code'].upper()
    rd_json = safe_get(f"room:{room}")
    if not rd_json: return
    rd = json.loads(rd_json)
    rd['current_state'].update(data['state'])
    safe_set(f"room:{room}", json.dumps(rd))
    emit('sync_player_state', data['state'], to=room, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001)