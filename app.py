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

# --- LOGGING SETUP ---
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

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
    logger.info("✅ Redis Connected")
except:
    logger.error("❌ Redis Offline")

YOUTUBE_API_KEY = os.getenv('YOUTUBE_API_KEY')
youtube_client = build('youtube', 'v3', developerKey=YOUTUBE_API_KEY) if YOUTUBE_API_KEY else None

def safe_get(key): return r.get(key)
def safe_set(key, value, ex=86400): r.set(key, value, ex=ex)

# --- ROUTES ---

@app.route('/ping')
def ping(): return jsonify({'status': 'ok'})

@app.route('/uploads/<path:filename>')
def serve_uploaded_file(filename):
    resp = send_from_directory(os.path.abspath(UPLOAD_FOLDER), filename)
    resp.headers.add('Access-Control-Allow-Origin', '*')
    resp.headers.add('Accept-Ranges', 'bytes')
    return resp

@app.route('/generate', methods=['POST'])
def generate_room():
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): break
    room_data = {'playlist': [], 'title': "Shared Sonic Space", 'users': {}, 'admin_sid': None, 'current_state': {'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'volume': 80}}
    safe_set(f"room:{code}", json.dumps(room_data))
    return jsonify({'room_code': code})

@app.route('/api/room/<code_in>')
def get_room(code_in):
    data = safe_get(f"room:{code_in.upper()}")
    return jsonify(json.loads(data) if data else {'error': 'Room not found'})

@app.route('/api/upload-local', methods=['POST'])
def upload_local():
    try:
        file = request.files['file']
        filename = secure_filename(f"{os.urandom(4).hex()}_{file.filename}")
        file.save(os.path.join(UPLOAD_FOLDER, filename))
        return jsonify({'audioUrl': url_for('serve_uploaded_file', filename=filename, _external=True, _scheme='https')})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/yt-search', methods=['POST'])
def search_yt():
    query = request.json.get('query')
    if youtube_client:
        try:
            req = youtube_client.search().list(q=query, part="snippet", maxResults=10, type="video")
            res = req.execute()
            return jsonify({'results': [{'id': i['id']['videoId'], 'title': i['snippet']['title'], 'artist': i['snippet']['channelTitle'], 'thumbnail': i['snippet']['thumbnails']['high']['url']} for i in res['items']]})
        except Exception as e:
            logger.error(f"API Search Fail: {e}")
    
    try:
        with yt_dlp.YoutubeDL({'quiet': True, 'default_search': 'ytsearch5', 'noplaylist': True}) as ydl:
            info = ydl.extract_info(query, download=False)
            return jsonify({'results': [{'id': e['id'], 'title': e['title'], 'artist': e.get('uploader', 'Unknown'), 'thumbnail': e.get('thumbnail')} for e in info['entries']]})
    except Exception as e:
        return jsonify({'results': [], 'error': 'Search currently unavailable.'})

@app.route('/api/room/<room_code>/add-yt', methods=['POST'])
def add_yt(room_code):
    try:
        data = request.json
        v_id = data['id']
        filename = f"{v_id}.mp3"
        path = os.path.join(UPLOAD_FOLDER, filename)
        
        if not os.path.exists(path):
            # THE CRITICAL CLIENT SPOOF FIX
            opts = {
                'format': 'bestaudio/best',
                'outtmpl': os.path.join(UPLOAD_FOLDER, f'{v_id}.%(ext)s'),
                'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}],
                'quiet': True,
                'nocheckcertificate': True,
                'extractor_args': {
                    'youtube': {
                        'player_client': ['ios', 'android', 'web'], # iOS is currently the most stable
                        'skip': ['webpage', 'hls', 'dash']
                    }
                }
            }
            with yt_dlp.YoutubeDL(opts) as ydl: 
                ydl.download([f"https://www.youtube.com/watch?v={v_id}"])
        
        lyrics = None
        try: lyrics = syncedlyrics.search(f"{data['title']} {data['artist']}")
        except: pass

        room_key = f"room:{room_code.upper()}"
        room_data_json = safe_get(room_key)
        if not room_data_json: return jsonify({'error': 'Room not found'}), 404
        
        room_data = json.loads(room_data_json)
        audio_url = url_for('serve_uploaded_file', filename=filename, _external=True, _scheme='https')
        
        new_track = {
            'name': data['title'], 
            'artist': data['artist'], 
            'audioUrl': audio_url, 
            'albumArt': data['thumbnail'], 
            'lyrics': lyrics,
            'isUpload': False
        }
        
        room_data['playlist'].append(new_track)
        if len(room_data['playlist']) == 1:
            room_data['current_state']['isPlaying'] = True
            socketio.emit('sync_player_state', room_data['current_state'], to=room_code.upper())
            
        safe_set(room_key, json.dumps(room_data))
        socketio.emit('refresh_playlist', room_data, to=room_code.upper())
        return jsonify({'success': True})
        
    except Exception as e:
        logger.error(f"Fatal Add YT Error: {traceback.format_exc()}")
        return jsonify({'error': 'YouTube download blocked. Try "Upload File" instead.'}), 200

@app.route('/api/room/<room_code>/add-upload', methods=['POST'])
def add_up(room_code):
    try:
        data = request.json
        room_key = f"room:{room_code.upper()}"
        room_data = json.loads(safe_get(room_key))
        new_track = {'name': data['title'], 'artist': data['artist'], 'audioUrl': data['audioUrl'], 'isUpload': True, 'albumArt': None, 'lyrics': None}
        room_data['playlist'].append(new_track)
        safe_set(room_key, json.dumps(room_data))
        socketio.emit('refresh_playlist', room_data, to=room_code.upper())
        return jsonify({'success': True})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@socketio.on('join_room')
def handle_join(data):
    room = data['room_code'].upper()
    join_room(room)
    room_data_json = safe_get(f"room:{room}")
    if not room_data_json: return
    room_data = json.loads(room_data_json)
    sid = request.sid
    is_admin = not room_data.get('admin_sid')
    if is_admin: room_data['admin_sid'] = sid
    room_data['users'][sid] = {'name': data.get('username', 'Guest'), 'isAdmin': is_admin}
    safe_set(f"room:{room}", json.dumps(room_data))
    emit('load_current_state', room_data['current_state'])
    emit('update_user_list', list(room_data['users'].values()), to=room)

@socketio.on('update_player_state')
def handle_state(data):
    room = data['room_code'].upper()
    rd_json = safe_get(f"room:{room}")
    if rd_json:
        rd = json.loads(rd_json)
        rd['current_state'].update(data['state'])
        safe_set(f"room:{room}", json.dumps(rd))
        emit('sync_player_state', data['state'], to=room, include_self=False)

if __name__ == '__main__':
    socketio.run(app, debug=True, host='0.0.0.0', port=5001)