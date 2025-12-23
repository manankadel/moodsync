import os, random, string, logging, time, json, subprocess
from flask import Flask, jsonify, request, send_from_directory, url_for
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
import redis
import requests
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

def safe_get(key): 
    return r.get(key)

def safe_set(key, value, ex=86400): 
    r.set(key, value, ex=ex)

def fetch_lyrics(title, artist):
    try:
        import syncedlyrics
        return syncedlyrics.search(f"{title} {artist}") or None
    except:
        return None

def download_youtube_audio(video_id, output_path):
    """Download YouTube audio using yt-dlp subprocess"""
    try:
        logger.info(f"📥 Starting download: {video_id}")
        
        cmd = [
            'yt-dlp',
            '--quiet',
            '--no-warnings',
            '-f', 'bestaudio/best',
            '-x',
            '--audio-format', 'mp3',
            '--audio-quality', '192',
            '-o', output_path,
            f'https://www.youtube.com/watch?v={video_id}',
        ]
        
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120)
        
        if result.returncode == 0:
            logger.info(f"✅ Download successful: {video_id}")
            return True
        else:
            logger.error(f"❌ yt-dlp failed: {result.stderr}")
            return False
    except subprocess.TimeoutExpired:
        logger.error(f"⏱️ Download timeout for {video_id}")
        return False
    except Exception as e:
        logger.error(f"❌ Download error: {str(e)}")
        return False

# --- ROUTES ---

@app.route('/ping')
def ping(): 
    return jsonify({'status': 'ok'})

@app.route('/uploads/<path:filename>')
def serve_file(filename):
    return send_from_directory(os.path.abspath(UPLOAD_FOLDER), filename)

@app.route('/generate', methods=['POST'])
def generate_room():
    while True:
        code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{code}"): 
            break
    
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

@app.route('/api/yt-search', methods=['POST'])
def search_yt():
    query = request.json.get('query')
    if not query: 
        return jsonify({'error': 'No query'}), 400
    
    logger.info(f"🔍 Searching: {query}")
    
    # Try YouTube API first
    if youtube_client:
        try:
            logger.info("Trying YouTube API...")
            req = youtube_client.search().list(q=query, part="snippet", maxResults=10, type="video")
            res = req.execute()
            results = [{
                'id': i['id']['videoId'],
                'title': i['snippet']['title'],
                'artist': i['snippet']['channelTitle'],
                'thumbnail': i['snippet']['thumbnails']['high']['url']
            } for i in res['items']]
            logger.info(f"✅ API search found {len(results)} results")
            return jsonify({'results': results})
        except Exception as e:
            logger.error(f"⚠️ API Search failed: {e}")
    
    # Fallback: Use invidious (free YouTube proxy)
    try:
        logger.info("Trying Invidious proxy...")
        invidious_url = "https://invidious.jing.rocks/api/v1/search"
        params = {
            'q': query,
            'type': 'video',
            'page': 1
        }
        
        response = requests.get(invidious_url, params=params, timeout=10)
        response.raise_for_status()
        data = response.json()
        
        results = []
        for item in data.get('items', [])[:10]:
            if item.get('type') == 'video':
                results.append({
                    'id': item.get('videoId'),
                    'title': item.get('title', 'Unknown'),
                    'artist': item.get('author', 'Unknown'),
                    'thumbnail': f"https://invidious.jing.rocks/vi/{item.get('videoId')}/maxresdefault.jpg"
                })
        
        logger.info(f"✅ Invidious found {len(results)} results")
        return jsonify({'results': results})
    
    except Exception as e:
        logger.error(f"❌ Invidious search failed: {e}")
        return jsonify({'error': f'Search failed: {str(e)}'}), 500

@app.route('/api/room/<room_code>/add-yt', methods=['POST'])
def add_yt_track(room_code):
    try:
        data = request.json
        video_id = data.get('id')
        title = data.get('title')
        artist = data.get('artist')
        
        logger.info(f"🎵 Adding track: {title} by {artist} (ID: {video_id})")
        
        filename = f"{video_id}.mp3"
        filepath = os.path.join(UPLOAD_FOLDER, filename)
        
        # Download if not exists
        if not os.path.exists(filepath):
            logger.info(f"📥 File not found, downloading: {video_id}")
            
            success = download_youtube_audio(video_id, filepath)
            
            if not success or not os.path.exists(filepath):
                logger.error(f"❌ Download failed or file not created: {filepath}")
                return jsonify({'error': 'Failed to download video. Try another song.'}), 500
        else:
            logger.info(f"✅ File already exists: {filepath}")
        
        # Generate serving URL
        audio_url = url_for('serve_file', filename=filename, _external=True, _scheme='https')
        logger.info(f"📡 Audio URL: {audio_url}")
        
        # Fetch lyrics
        lyrics = fetch_lyrics(title, artist)

        # Update room
        room_key = f"room:{room_code.upper()}"
        with r.lock(f"lock:{room_key}", timeout=5):
            room_data = json.loads(safe_get(room_key) or '{}')
            if not room_data: 
                logger.error(f"Room not found: {room_code}")
                return jsonify({'error': 'Room not found'}), 404
            
            new_track = {
                'name': title, 
                'artist': artist, 
                'audioUrl': audio_url, 
                'albumArt': data.get('thumbnail'),
                'lyrics': lyrics
            }
            
            room_data['playlist'].append(new_track)
            
            if len(room_data['playlist']) == 1:
                room_data['current_state'].update({'trackIndex': 0, 'isPlaying': True})
                socketio.emit('sync_player_state', room_data['current_state'], to=room_code.upper())

            safe_set(room_key, json.dumps(room_data))
            socketio.emit('refresh_playlist', room_data, to=room_code.upper())
            
            logger.info(f"✅ Track added successfully: {title}")

        return jsonify({'success': True}), 200
        
    except Exception as e:
        logger.error(f"❌ Add track failed: {str(e)}", exc_info=True)
        return jsonify({'error': f'Internal error: {str(e)}'}), 500

# --- SOCKET ---
@socketio.on('join_room')
def handle_join(data):
    room, user, sid = data['room_code'].upper(), data.get('username', 'Guest'), request.sid
    join_room(room)
    room_key = f"room:{room}"
    
    room_data_json = safe_get(room_key)
    if not room_data_json: 
        return
    room_data = json.loads(room_data_json)
    
    is_admin = not room_data.get('admin_sid')
    if is_admin: 
        room_data['admin_sid'] = sid
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