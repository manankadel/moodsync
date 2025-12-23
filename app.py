import os, random, string, logging, time, json
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
        return syncedlyrics.search(f"{title} {artist}") or None
    except:
        return None

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
    
    # Try API first (Most Reliable)
    if youtube_client:
        try:
            req = youtube_client.search().list(q=query, part="snippet", maxResults=10, type="video")
            res = req.execute()
            return jsonify({'results': [{
                'id': i['id']['videoId'],
                'title': i['snippet']['title'],
                'artist': i['snippet']['channelTitle'],
                'thumbnail': i['snippet']['thumbnails']['high']['url']
            } for i in res['items']]})
        except Exception as e:
            logger.error(f"API Search Failed: {e}")
    
    # Fallback to Scraping
    try:
        ydl_opts = {'format': 'bestaudio', 'noplaylist': True, 'quiet': True, 'default_search': 'ytsearch5'}
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(query, download=False)
            return jsonify({'results': [{
                'id': e['id'], 
                'title': e['title'], 
                'artist': e.get('uploader', 'Unknown'),
                'thumbnail': e.get('thumbnail')
            } for e in info['entries']]})
    except Exception as e:
        return jsonify({'error': str(e)}), 500

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
        audio_url = url_for('serve_file', filename=filename, _external=True, _scheme='https')

        if not os.path.exists(filepath):
            logger.info(f"📥 Downloading: {video_id}")
            try:
                ydl_opts = {
                    'format': 'bestaudio/best',
                    'outtmpl': os.path.join(UPLOAD_FOLDER, f'{video_id}.%(ext)s'),
                    'postprocessors': [{'key': 'FFmpegExtractAudio', 'preferredcodec': 'mp3', 'preferredquality': '192'}],
                    'quiet': False,
                    'no_warnings': False,
                    'nocheckcertificate': True,
                    'socket_timeout': 30,
                    'extractor_args': {'youtube': {'player_client': ['web']}},
                    'http_headers': {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'en-us,en;q=0.5',
                        'Accept-Encoding': 'gzip, deflate',
                        'DNT': '1',
                        'Connection': 'keep-alive',
                        'Upgrade-Insecure-Requests': '1'
                    }
                }
                
                with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                    logger.info(f"⏳ Starting download for {video_id}...")
                    info = ydl.extract_info(f"https://www.youtube.com/watch?v={video_id}", download=True)
                    logger.info(f"✅ Download complete for {video_id}")
                    
            except Exception as e:
                logger.error(f"❌ Download failed for {video_id}: {str(e)}", exc_info=True)
                return jsonify({'error': f'Failed to download video: {str(e)}'}), 500

        # Check if file was created
        if not os.path.exists(filepath):
            logger.error(f"File not found after download: {filepath}")
            return jsonify({'error': 'Download completed but file not found'}), 500

        # Fetch Lyrics
        lyrics = fetch_lyrics(title, artist)

        # Update Room
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