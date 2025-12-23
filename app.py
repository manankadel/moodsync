import os, random, string, logging, time, json, re
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

load_dotenv()

# --- SETUP ---
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)
CORS(app, origins="*")
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='gevent')

# --- CONFIG ---
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
YOUTUBE_API_KEY = os.getenv('YOUTUBE_API_KEY')
youtube = build('youtube', 'v3', developerKey=YOUTUBE_API_KEY) if YOUTUBE_API_KEY else None

# --- REDIS ---
redis_url = os.getenv('REDIS_URL', 'redis://localhost:6379')
r = redis.from_url(redis_url, decode_responses=True)

def safe_get(key): return r.get(key)
def safe_set(key, val, ex=86400): r.set(key, val, ex=ex)

# --- HELPERS ---
def get_lyrics(term):
    """Finds lyrics using syncedlyrics"""
    try:
        # Search for LRC (Synced) first, fallback to plain text
        lrc = syncedlyrics.search(term)
        return lrc if lrc else None
    except Exception as e:
        print(f"Lyrics Error: {e}")
        return None

# --- ROUTES ---
@app.route('/ping')
def ping(): return jsonify({'time': time.time()})

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    return send_from_directory(os.path.abspath(UPLOAD_FOLDER), filename)

@app.route('/generate', methods=['POST'])
def generate():
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): break
    
    room_data = {
        'playlist': [],
        'title': "Sonic Space",
        'users': {},
        'admin_sid': None,
        'current_state': {'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'volume': 80, 'equalizer': {'bass': 0, 'mids': 0, 'treble': 0}}
    }
    safe_set(f"room:{code}", json.dumps(room_data))
    return jsonify({'room_code': code})

@app.route('/api/room/<code_in>')
def get_room(code_in):
    data = safe_get(f"room:{code_in.upper()}")
    return jsonify(json.loads(data) if data else {'error': 'Not found'})

# --- 1. LOCAL UPLOAD ---
@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files: return jsonify({'error': 'No file'}), 400
    file = request.files['file']
    filename = secure_filename(f"{os.urandom(4).hex()}_{file.filename}")
    path = os.path.join(UPLOAD_FOLDER, filename)
    file.save(path)
    
    url = url_for('serve_file', filename=filename, _external=True, _scheme='https')
    return jsonify({'url': url, 'filename': filename})

# --- 2. YOUTUBE SEARCH ---
@app.route('/api/search', methods=['POST'])
def search_yt():
    if not youtube: return jsonify({'error': 'Server missing YouTube Key'}), 500
    q = request.json.get('query')
    try:
        req = youtube.search().list(q=q, part="snippet", maxResults=10, type="video")
        res = req.execute()
        items = [{'id': i['id']['videoId'], 'title': i['snippet']['title'], 'artist': i['snippet']['channelTitle'], 'thumb': i['snippet']['thumbnails']['default']['url']} for i in res['items']]
        return jsonify({'results': items})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

# --- 3. ADD TRACK (Universal) ---
@app.route('/api/room/add', methods=['POST'])
def add_track():
    data = request.json
    room_code = data.get('code', '').upper()
    
    # Is it a YouTube ID or a direct Upload?
    video_id = data.get('videoId')
    direct_url = data.get('audioUrl')
    
    final_url = direct_url
    
    # If YouTube, Download it
    if video_id:
        filename = f"{video_id}.mp3"
        filepath = os.path.join(UPLOAD_FOLDER, filename)
        
        if not os.path.exists(filepath):
            try:
                ydl_opts = {
                    'format': 'bestaudio/best',
                    'outtmpl': os.path.join(UPLOAD_FOLDER, f'{video_id}.%(ext)s'),
                    'postprocessors': [{'key': 'FFmpegExtractAudio','preferredcodec': 'mp3'}],
                    'quiet': True
                }
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    ydl.download([f"https://www.youtube.com/watch?v={video_id}"])
            except Exception as e:
                return jsonify({'error': f"Download failed: {str(e)}"}), 500
        
        final_url = url_for('serve_file', filename=filename, _external=True, _scheme='https')

    # Fetch Lyrics
    lyrics = get_lyrics(f"{data.get('title')} {data.get('artist')}")

    # Update Redis
    room_key = f"room:{room_code}"
    with r.lock(f"lock:{room_key}", timeout=5):
        room_data = json.loads(safe_get(room_key) or '{}')
        if not room_data: return jsonify({'error': 'Room missing'}), 404
        
        new_track = {
            'name': data.get('title'),
            'artist': data.get('artist'),
            'audioUrl': final_url,
            'lyrics': lyrics, # <--- Lyrics added here
            'albumArt': data.get('thumb')
        }
        
        room_data['playlist'].append(new_track)
        
        # Auto-play if first
        if len(room_data['playlist']) == 1:
             room_data['current_state']['isPlaying'] = True
             socketio.emit('sync_player_state', room_data['current_state'], to=room_code)

        safe_set(room_key, json.dumps(room_data))
        socketio.emit('refresh_playlist', room_data, to=room_code)

    return jsonify({'success': True})

# --- SOCKET ---
@socketio.on('join_room')
def on_join(data):
    room = data['room_code'].upper()
    join_room(room)
    room_data = json.loads(safe_get(f"room:{room}") or '{}')
    if room_data:
        emit('refresh_playlist', room_data)
        emit('sync_player_state', room_data['current_state'])

@socketio.on('update_player_state')
def on_state(data):
    room = data['room_code'].upper()
    state = data['state']
    # Quick Update
    r_key = f"room:{room}"
    rd = json.loads(safe_get(r_key) or '{}')
    if rd:
        rd['current_state'].update(state)
        safe_set(r_key, json.dumps(rd))
        emit('sync_player_state', state, to=room, include_self=False)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=5001)