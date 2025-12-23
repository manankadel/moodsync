import os, random, string, logging, time, json, traceback
from flask import Flask, jsonify, request, send_from_directory, url_for
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
import redis
import yt_dlp
import syncedlyrics
from googleapiclient.discovery import build
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

# --- LOGGING SETUP ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

load_dotenv()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# --- CONFIGURATION ---
# Max file size: 50MB
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024
CORS(app, resources={r"/*": {"origins": "*"}}, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# --- CONNECTIONS ---
try:
    redis_url = os.getenv('REDIS_URL', 'redis://localhost:6379')
    r = redis.from_url(redis_url, decode_responses=True)
    r.ping()
    logger.info("✅ Redis Connected")
except Exception as e:
    logger.error(f"❌ Redis Connection Failed: {e}")

YOUTUBE_API_KEY = os.getenv('YOUTUBE_API_KEY')
youtube_client = None
if YOUTUBE_API_KEY:
    try:
        youtube_client = build('youtube', 'v3', developerKey=YOUTUBE_API_KEY)
        logger.info("✅ YouTube API Client Ready")
    except Exception as e:
        logger.error(f"⚠️ YouTube API Error: {e}")

def safe_get(key): return r.get(key)
def safe_set(key, value, ex=86400): r.set(key, value, ex=ex)

def fetch_lyrics(title, artist):
    try:
        return syncedlyrics.search(f"{title} {artist}") or None
    except:
        return None

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in {'mp3', 'wav', 'ogg', 'm4a', 'flac'}

# --- ROUTES ---

@app.route('/ping')
def ping(): return jsonify({'status': 'ok', 'time': time.time()})

@app.route('/uploads/<path:filename>')
def serve_uploaded_file(filename):
    return send_from_directory(os.path.abspath(UPLOAD_FOLDER), filename)

@app.route('/generate', methods=['POST'])
def generate_room():
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): break
    
    room_data = {
        'playlist': [], 
        'title': "Shared Sonic Space", 
        'users': {}, 
        'admin_sid': None, 
        'current_state': {'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'volume': 80}
    }
    safe_set(f"room:{code}", json.dumps(room_data))
    return jsonify({'room_code': code})

@app.route('/api/room/<code_in>')
def get_room(code_in):
    data = safe_get(f"room:{code_in.upper()}")
    return jsonify(json.loads(data) if data else {'error': 'Room not found'})

# === RESTORED: LOCAL UPLOAD ROUTE ===
@app.route('/api/upload-local', methods=['POST'])
def upload_local():
    if 'file' not in request.files: return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '': return jsonify({'error': 'No selected file'}), 400
    if file and allowed_file(file.filename):
        filename = secure_filename(f"{os.urandom(8).hex()}_{file.filename}")
        file.save(os.path.join(UPLOAD_FOLDER, filename))
        audio_url = url_for('serve_uploaded_file', filename=filename, _external=True, _scheme='https')
        return jsonify({'audioUrl': audio_url})
    return jsonify({'error': 'Invalid file type'}), 400

# === RESTORED: ADD LOCAL TRACK TO PLAYLIST ===
@app.route('/api/room/<room_code>/add-upload', methods=['POST'])
def add_upload_to_room(room_code):
    data = request.json
    room_key = f"room:{room_code.upper()}"
    
    with r.lock(f"lock:{room_key}", timeout=5):
        room_data_json = safe_get(room_key)
        if not room_data_json: return jsonify({'error': 'Room not found'}), 404
        
        room_data = json.loads(room_data_json)
        new_track = {
            'name': data.get('title'),
            'artist': data.get('artist'),
            'isUpload': True,
            'audioUrl': data.get('audioUrl'),
            'albumArt': None,
            'lyrics': None
        }
        
        room_data['playlist'].append(new_track)
        
        # Auto-play if first
        if len(room_data['playlist']) == 1:
            room_data['current_state'].update({'trackIndex': 0, 'isPlaying': True})
            socketio.emit('sync_player_state', room_data['current_state'], to=room_code.upper())

        safe_set(room_key, json.dumps(room_data))
        socketio.emit('refresh_playlist', room_data, to=room_code.upper())
        
    return jsonify({'message': 'Track added'}), 200

# === YOUTUBE ROUTES ===@app.route('/api/yt-search', methods=['POST'])
def search_yt():
    query = request.json.get('query')
    if not query: return jsonify({'error': 'No query'}), 400
    
    # 1. API Method
    if youtube_client:
        try:
            req = youtube_client.search().list(q=query, part="snippet", maxResults=5, type="video")
            res = req.execute()
            return jsonify({'results': [{
                'id': i['id']['videoId'],
                'title': i['snippet']['title'],
                'artist': i['snippet']['channelTitle'],
                'thumbnail': i['snippet']['thumbnails']['high']['url']
            } for i in res['items']]})
        except Exception as e:
            logger.error(f"API Error: {e}") # Log but continue

    # 2. Scraping Method (Fallback)
    try:
        ydl_opts = {'format': 'bestaudio', 'noplaylist': True, 'quiet': True, 'default_search': 'ytsearch5'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(query, download=False)
            # Handle case where search returns no entries
            if 'entries' not in info: raise Exception("No entries found")
            return jsonify({'results': [{
                'id': e['id'], 
                'title': e['title'], 
                'artist': e.get('uploader', 'Unknown'),
                'thumbnail': e.get('thumbnail')
            } for e in info['entries']]})
    except Exception as e:
        logger.error(f"Scraping Error: {e}")
        # RETURN 200 with empty list or error message so frontend doesn't crash
        return jsonify({'results': [], 'message': 'YouTube search is currently unavailable. Please use "Upload File".'}), 200

@app.route('/api/room/<room_code>/add-yt', methods=['POST'])
def add_yt_track(room_code):
    data = request.json
    video_id = data.get('id')
    title = data.get('title')
    artist = data.get('artist')
    
    filename = f"{video_id}.mp3"
    filepath = os.path.join(UPLOAD_FOLDER, filename)
    audio_url = url_for('serve_uploaded_file', filename=filename, _external=True, _scheme='https')

    if not os.path.exists(filepath):
        try:
            # SPOOF ANDROID CLIENT TO BYPASS BLOCKS
            ydl_opts = {
                'format': 'bestaudio/best',
                'outtmpl': os.path.join(UPLOAD_FOLDER, f'{video_id}.%(ext)s'),
                'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}],
                'quiet': True,
                'nocheckcertificate': True,
                'no_cache_dir': True,
                'extractor_args': {'youtube': {'player_client': ['android', 'web']}}
            }
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
        except Exception as e:
            return jsonify({'error': f"Download failed: {str(e)}"}), 500

    lyrics = fetch_lyrics(title, artist)

    room_key = f"room:{room_code.upper()}"
    with r.lock(f"lock:{room_key}", timeout=5):
        room_data_json = safe_get(room_key)
        if not room_data_json: return jsonify({'error': 'Room not found'}), 404
        
        room_data = json.loads(room_data_json)
        new_track = {
            'name': title, 'artist': artist, 'isUpload': False,
            'audioUrl': audio_url, 'albumArt': data.get('thumbnail'), 'lyrics': lyrics
        }
        
        room_data['playlist'].append(new_track)
        
        if len(room_data['playlist']) == 1:
            room_data['current_state'].update({'trackIndex': 0, 'isPlaying': True})
            socketio.emit('sync_player_state', room_data['current_state'], to=room_code.upper())

        safe_set(room_key, json.dumps(room_data))
        socketio.emit('refresh_playlist', room_data, to=room_code.upper())

    return jsonify({'success': True}), 200

# --- SOCKET HANDLERS ---
@socketio.on('join_room')
def handle_join(data):
    room, user, sid = data['room_code'].upper(), data.get('username', 'Guest'), request.sid
    join_room(room)
    room_key = f"room:{room}"
    
    room_data_json = safe_get(room_key)
    if not room_data_json: return
    room_data = json.loads(room_data_json)
    
    is_admin = not room_data.get('admin_sid')
    if is_admin: room_data['admin_sid'] = sid
    room_data['users'][sid] = {'name': user, 'isAdmin': is_admin}
    
    safe_set(room_key, json.dumps(room_data))
    emit('load_current_state', room_data['current_state'])
    emit('update_user_list', list(room_data['users'].values()), to=room)

@socketio.on('update_player_state')
def handle_state(data):
    room = data['room_code'].upper()
    state = data['state']
    rd_json = safe_get(f"room:{room}")
    if rd_json:
        rd = json.loads(rd_json)
        rd['current_state'].update(state)
        safe_set(f"room:{room}", json.dumps(rd))
        emit('sync_player_state', state, to=room, include_self=False)

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5001)