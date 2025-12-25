import os, random, string, logging, time, json, traceback
from flask import Flask, jsonify, request, send_from_directory, url_for, Response
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
import redis
import yt_dlp
import syncedlyrics
from googleapiclient.discovery import build
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

try:
    r = redis.from_url(os.getenv('REDIS_URL', 'redis://localhost:6379'), decode_responses=True)
    r.ping()
except:
    print("Redis offline")

YOUTUBE_API_KEY = os.getenv('YOUTUBE_API_KEY')
youtube_client = build('youtube', 'v3', developerKey=YOUTUBE_API_KEY) if YOUTUBE_API_KEY else None

def safe_get(key): return r.get(key)
def safe_set(key, value, ex=86400): r.set(key, value, ex=ex)

# --- ROUTES ---

@app.route('/uploads/<path:filename>')
def serve_uploaded_file(filename):
    # CRITICAL: Allow range requests for audio scrubbing
    resp = send_from_directory(os.path.abspath(UPLOAD_FOLDER), filename)
    resp.headers.add('Access-Control-Allow-Origin', '*')
    resp.headers.add('Accept-Ranges', 'bytes')
    return resp

@app.route('/generate', methods=['POST'])
def generate_room():
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): break
    room_data = {'playlist': [], 'title': "Sonic Space", 'users': {}, 'admin_sid': None, 'current_state': {'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'volume': 80}}
    safe_set(f"room:{code}", json.dumps(room_data))
    return jsonify({'room_code': code})

@app.route('/api/room/<code_in>')
def get_room(code_in):
    data = safe_get(f"room:{code_in.upper()}")
    return jsonify(json.loads(data) if data else {'error': 'Room not found'})

@app.route('/api/upload-local', methods=['POST'])
def upload_local():
    file = request.files['file']
    filename = secure_filename(f"{os.urandom(4).hex()}_{file.filename}")
    file.save(os.path.join(UPLOAD_FOLDER, filename))
    return jsonify({'audioUrl': url_for('serve_uploaded_file', filename=filename, _external=True, _scheme='https' if not app.debug else 'http')})

@app.route('/api/yt-search', methods=['POST'])
def search_yt():
    query = request.json.get('query')
    if youtube_client:
        try:
            req = youtube_client.search().list(q=query, part="snippet", maxResults=5, type="video")
            res = req.execute()
            return jsonify({'results': [{'id': i['id']['videoId'], 'title': i['snippet']['title'], 'artist': i['snippet']['channelTitle'], 'thumbnail': i['snippet']['thumbnails']['high']['url']} for i in res['items']]})
        except: pass
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'default_search': 'ytsearch5'}) as ydl:
            info = ydl.extract_info(query, download=False)
            return jsonify({'results': [{'id': e['id'], 'title': e['title'], 'artist': e.get('uploader', 'Unknown'), 'thumbnail': e.get('thumbnail')} for e in info['entries']]})
    except Exception as e:
        return jsonify({'results': [], 'message': str(e)})

@app.route('/api/room/<room_code>/add-yt', methods=['POST'])
def add_yt(room_code):
    data = request.json
    v_id = data['id']
    path = os.path.join(UPLOAD_FOLDER, f"{v_id}.mp3")
    if not os.path.exists(path):
        opts = {'format': 'bestaudio/best', 'outtmpl': os.path.join(UPLOAD_FOLDER, f'{v_id}.%(ext)s'), 'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3'}], 'quiet': True, 'extractor_args': {'youtube': {'player_client': ['android', 'web']}}}
        with yt_dlp.YoutubeDL(opts) as ydl: ydl.download([f"https://www.youtube.com/watch?v={v_id}"])
    
    lyrics = None
    try: lyrics = syncedlyrics.search(f"{data['title']} {data['artist']}")
    except: pass

    room_key = f"room:{room_code.upper()}"
    room_data = json.loads(safe_get(room_key))
    new_track = {'name': data['title'], 'artist': data['artist'], 'audioUrl': url_for('serve_uploaded_file', filename=f"{v_id}.mp3", _external=True), 'albumArt': data['thumbnail'], 'lyrics': lyrics}
    room_data['playlist'].append(new_track)
    if len(room_data['playlist']) == 1: room_data['current_state']['isPlaying'] = True
    safe_set(room_key, json.dumps(room_data))
    socketio.emit('refresh_playlist', room_data, to=room_code.upper())
    return jsonify({'success': True})

@app.route('/api/room/<room_code>/add-upload', methods=['POST'])
def add_up(room_code):
    data = request.json
    room_key = f"room:{room_code.upper()}"
    room_data = json.loads(safe_get(room_key))
    new_track = {'name': data['title'], 'artist': data['artist'], 'audioUrl': data['audioUrl'], 'isUpload': True, 'albumArt': None, 'lyrics': None}
    room_data['playlist'].append(new_track)
    safe_set(room_key, json.dumps(room_data))
    socketio.emit('refresh_playlist', room_data, to=room_code.upper())
    return jsonify({'success': True})

@socketio.on('join_room')
def handle_join(data):
    room = data['room_code'].upper()
    join_room(room)
    room_data = json.loads(safe_get(f"room:{room}") or '{}')
    if not room_data: return
    sid = request.sid
    is_admin = not room_data.get('admin_sid')
    if is_admin: room_data['admin_sid'] = sid
    room_data['users'][sid] = {'name': data.get('username', 'Guest'), 'isAdmin': is_admin}
    safe_set(f"room:{room}", json.dumps(room_data))
    emit('sync_player_state', room_data['current_state'])
    emit('update_user_list', list(room_data['users'].values()), to=room)

@socketio.on('update_player_state')
def handle_state(data):
    room = data['room_code'].upper()
    rd = json.loads(safe_get(f"room:{room}"))
    rd['current_state'].update(data['state'])
    safe_set(f"room:{room}", json.dumps(rd))
    emit('sync_player_state', data['state'], to=room, include_self=False)

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5001)