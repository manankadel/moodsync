import os, base64, random, string, logging, time, requests, json
from functools import lru_cache
from flask import Flask, jsonify, request, send_from_directory
from flask_socketio import SocketIO, join_room, emit, rooms
from flask_cors import CORS
from dotenv import load_dotenv
from googleapiclient.discovery import build
from googleapiclient import errors
import redis
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix
import mimetypes
from datetime import datetime

# Imports for lrc_kit
lrc_kit_available = False
try:
    from lrc_kit.lrc import parse_lyrics
    lrc_kit_available = True
    print("✅ Successfully imported parse_lyrics from lrc_kit.lrc")
except ImportError:
    try:
        import lrc_kit.lrc as lrc_module
        parse_lyrics = lrc_module.parse_lyrics
        lrc_kit_available = True
        print("✅ Successfully imported parse_lyrics via lrc_module")
    except (ImportError, AttributeError):
        print("❌ Could not import lrc_kit parse_lyrics. Lyrics functionality will be disabled.")
        lrc_kit_available = False

# --- APP INITIALIZATION ---
load_dotenv()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# --- FIXED CORS SETUP ---
# We must explicitly allow the frontend origin (usually localhost:3000 for Next.js)
# to make POST requests and establish WebSocket connections.
FRONTEND_ORIGIN = os.getenv("FRONTEND_ORIGIN", "http://localhost:3000")

# Enable CORS for HTTP requests (like /generate)
CORS(app, resources={r"/*": {"origins": FRONTEND_ORIGIN}}, supports_credentials=True)

app.secret_key = os.urandom(24)

# Enable CORS for Socket.IO (WebSockets)
socketio = SocketIO(app, cors_allowed_origins=[FRONTEND_ORIGIN], ping_timeout=60, ping_interval=25)

UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'mp3', 'wav', 'ogg', 'm4a', 'flac'}
MAX_FILE_SIZE = 50 * 1024 * 1024
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = MAX_FILE_SIZE

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# --- DATABASE CONNECTION (REDIS) ---
try:
    redis_url = os.getenv('REDIS_URL', 'redis://localhost:6379')
    r = redis.from_url(redis_url, decode_responses=True)
    r.ping()
    app.logger.info(f"Successfully connected to Redis at {redis_url}")
except redis.exceptions.ConnectionError as e:
    app.logger.error(f"FATAL: Could not connect to Redis. Please ensure Redis is running. Error: {e}")
    # Do not exit, just log. Routes will fail gracefully if Redis is down.

# --- GLOBAL CONFIG & FALLBACKS ---
spotify_token_cache = {'token': None, 'expires': 0}
token_failure_count, last_token_failure = 0, 0

GENRE_CONFIGS = {
    'deep-house': {'seeds': ['deep-house', 'minimal-techno']}, 
    'house': {'seeds': ['house', 'dance']},
    'progressive-house': {'seeds': ['progressive-house', 'edm']}, 
    'tech-house': {'seeds': ['tech-house', 'techno']},
    'techno': {'seeds': ['techno', 'hardstyle', 'industrial']}, 
    'minimal-techno': {'seeds': ['minimal-techno', 'ambient', 'electronic']},
    'detroit-techno': {'seeds': ['detroit-techno', 'techno']}, 
    'electronica': {'seeds': ['electronica', 'idm']},
    'edm': {'seeds': ['edm', 'electro', 'dance']}, 
    'electro': {'seeds': ['electro', 'chicago-house']},
    'dubstep': {'seeds': ['dubstep', 'bass-music']}, 
    'indie': {'seeds': ['indie', 'indie-pop', 'alternative']},
    'indie-pop': {'seeds': ['indie-pop', 'pop']}, 
    'alternative': {'seeds': ['alternative', 'rock']},
    'boiler-room': {'search_query': 'Boiler Room set'}, 
    'live-techno-set': {'search_query': 'live techno set'},
    'deep-house-mix': {'search_query': 'deep house mix'}, 
    'default': {'seeds': ['music', 'pop']}
}

FALLBACK_PLAYLIST = [
    {'name': 'Blinding Lights', 'artist': 'The Weeknd', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36', 'youtubeId': '4NRXx6U8ABQ'},
    {'name': 'As It Was', 'artist': 'Harry Styles', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b273b46f74097652c7f3a3a08237', 'youtubeId': 'H5v3kku4y6Q'},
]

# --- API FUNCTIONS ---
@lru_cache(maxsize=1)
def get_spotify_credentials(): 
    return os.getenv('SPOTIFY_CLIENT_ID'), os.getenv('SPOTIFY_CLIENT_SECRET')

def get_spotify_token():
    global token_failure_count, last_token_failure
    if token_failure_count >= 3 and time.time() - last_token_failure < 300: 
        return None
    if time.time() < spotify_token_cache['expires'] and spotify_token_cache['token']: 
        return spotify_token_cache['token']
    client_id, client_secret = get_spotify_credentials()
    if not client_id or not client_secret: 
        app.logger.warning("Spotify credentials not found. Using fallback.")
        return None
    try:
        auth_str = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        response = requests.post("https://accounts.spotify.com/api/token", headers={"Authorization": f"Basic {auth_str}", "Content-Type": "application/x-www-form-urlencoded"}, data={"grant_type": "client_credentials"}, timeout=10)
        if response.status_code != 200: 
            app.logger.error(f"Spotify token failed: {response.text}")
            token_failure_count += 1; last_token_failure = time.time(); return None
        data = response.json()
        if 'access_token' not in data: 
            token_failure_count += 1; last_token_failure = time.time(); return None
        spotify_token_cache['token'] = data['access_token']
        spotify_token_cache['expires'] = time.time() + data.get('expires_in', 3600) - 60
        token_failure_count = 0
        return data['access_token']
    except Exception as e: 
        app.logger.error(f"Spotify token exception: {e}")
        token_failure_count += 1; last_token_failure = time.time(); return None

def get_youtube_video_id_fallback(query):
    try:
        invidious_api_url = f"https://invidious.io.gg/api/v1/search?q={query}"
        response = requests.get(invidious_api_url, timeout=10)
        response.raise_for_status()
        results = response.json()
        if results and isinstance(results, list) and len(results) > 0:
            return results[0].get('videoId')
        return None
    except Exception as e:
        app.logger.error(f"Invidious fallback search failed for '{query}': {e}")
        return None

def get_youtube_video_id(song_name, artist_name):
    try:
        cache_key = f"youtube:v2:{song_name}_{artist_name}".lower().replace(' ', '_')
        cached_id = r.get(cache_key)
        if cached_id: 
            return None if cached_id == "none" else cached_id
    except redis.exceptions.ConnectionError:
        pass # Skip cache if Redis is down

    youtube_api_key = os.getenv('YOUTUBE_API_KEY')
    video_id = None
    query = f"{song_name} {artist_name} official audio"
    
    if youtube_api_key:
        try:
            youtube = build('youtube', 'v3', developerKey=youtube_api_key)
            search_request = youtube.search().list(q=query, part='snippet', maxResults=1, type='video', videoCategoryId='10')
            response = search_request.execute()
            video_id = response['items'][0]['id']['videoId'] if response.get('items') else None
        except Exception as e:
            app.logger.error(f"YouTube API error for '{query}': {e}")
            video_id = None
            
    if not video_id:
        video_id = get_youtube_video_id_fallback(query)
        
    try:
        r.set(cache_key, video_id if video_id else "none", ex=86400 * 7)
    except redis.exceptions.ConnectionError:
        pass
        
    return video_id

def generate_playlist(genre):
    app.logger.info(f"Generating playlist for genre: {genre}")
    try:
        config = GENRE_CONFIGS.get(genre, GENRE_CONFIGS['default'])
        token = get_spotify_token()
        
        if not token:
            app.logger.warning("No Spotify token available. Returning fallback.")
            return FALLBACK_PLAYLIST

        if 'search_query' in config:
            params = {'q': config['search_query'], 'type': 'track', 'limit': 30, 'market': 'US'}
            response = requests.get("https://api.spotify.com/v1/search", headers={"Authorization": f"Bearer {token}"}, params=params)
        else:
            seeds = random.sample(config['seeds'], min(2, len(config['seeds'])))
            params = {'seed_genres': ','.join(seeds), 'limit': 30, 'market': 'US'}
            response = requests.get("https://api.spotify.com/v1/recommendations", headers={"Authorization": f"Bearer {token}"}, params=params)
            
        if response.status_code != 200:
            raise Exception(f"Spotify API returned {response.status_code}: {response.text}")
            
        data = response.json()
        tracks = data.get('tracks', {}).get('items', []) or data.get('tracks', [])
        
        if not tracks: 
            raise Exception(f"No tracks found by Spotify for genre: {genre}")
            
        # Simplify sorting to avoid errors if 'popularity' is missing
        tracks.sort(key=lambda x: x.get('popularity', 0), reverse=True)
        
        playlist = []
        for track in tracks:
            if len(playlist) >= 15: break
            
            # Safely get artist and song names
            artists = track.get('artists', [])
            if not artists: continue
            artist_name = artists[0].get('name')
            song_name = track.get('name')
            
            if not song_name or not artist_name: continue
            
            video_id = get_youtube_video_id(song_name, artist_name)
            
            if video_id:
                # Safely get album art
                album = track.get('album', {})
                images = album.get('images', [])
                album_art = images[0]['url'] if images else None
                
                playlist.append({'name': song_name, 'artist': artist_name, 'albumArt': album_art, 'youtubeId': video_id})
                
        if not playlist: 
            app.logger.warning("Spotify returned tracks, but no YouTube videos were found. Using fallback.")
            return FALLBACK_PLAYLIST
            
        return playlist
        
    except Exception as e:
        app.logger.error(f"Playlist generation failed: {e}. Using fallback.")
        return FALLBACK_PLAYLIST

# --- ROUTES & SOCKETS ---
@app.route('/', methods=['GET'])
def health_check():
    return jsonify({'status': 'healthy', 'service': 'MoodSync Backend'}), 200

@app.route('/generate', methods=['POST', 'OPTIONS'])
def generate_route():
    # Handle preflight request for CORS
    if request.method == 'OPTIONS':
        response = app.make_default_options_response()
        return response

    try:
        data = request.get_json()
        if not data:
            return jsonify({'error': 'Invalid JSON'}), 400
            
        genre = data.get('mood', 'default').lower()
        app.logger.info(f"Received generate request for mood: {genre}")
        
        playlist = generate_playlist(genre)
        
        # Generate unique room code
        max_attempts = 10
        for _ in range(max_attempts):
            room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
            try:
                if not r.exists(f"room:{room_code}"): break
            except redis.exceptions.ConnectionError:
                break # If Redis is down, just use the generated code
        else:
             return jsonify({'error': 'Failed to generate unique room code'}), 500

        title = genre.replace('-', ' ').title() if genre != 'default' else "Curated Vibes"
        
        room_data = {
            'playlist': playlist, 
            'title': title, 
            'users': {}, 
            'admin_sid': None, 
            'current_state': {
                'isPlaying': False, 
                'trackIndex': 0, 
                'currentTime': 0, 
                'volume': 80, 
                'timestamp': time.time(),
                'serverTimestamp': time.time(),
                'equalizer': {'bass': 0, 'mids': 0, 'treble': 0},
                'isCollaborative': False
            }, 
            'created_at': time.time()
        }
        
        try:
            r.set(f"room:{room_code}", json.dumps(room_data), ex=86400) # 24 hours
            app.logger.info(f"Room {room_code} created successfully.")
            return jsonify({'room_code': room_code}), 200
        except redis.exceptions.ConnectionError as e:
            app.logger.error(f"Redis error saving room: {e}")
            return jsonify({'error': 'Database error'}), 500
            
    except Exception as e:
        app.logger.error(f"Error in /generate: {e}")
        return jsonify({'error': str(e)}), 500

@app.route('/api/room/<string:room_code>', methods=['GET'])
def get_room_data(room_code):
    room_code = room_code.upper()
    try:
        room_data_json = r.get(f"room:{room_code}")
        if not room_data_json: 
            return jsonify({'error': 'Room not found'}), 404
        room_data = json.loads(room_data_json)
        return jsonify({'playlist_title': room_data['title'], 'playlist': room_data['playlist']}), 200
    except redis.exceptions.ConnectionError:
        return jsonify({'error': 'Database unavailable'}), 503

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, secure_filename(filename))

@app.route('/api/upload', methods=['POST'])
def upload_file_route():
    if 'file' not in request.files: return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '': return jsonify({'error': 'No selected file'}), 400
    
    if file and allowed_file(file.filename):
        filename = secure_filename(file.filename)
        unique_filename = f"{os.urandom(8).hex()}_{filename}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        try:
            file.save(file_path)
            audio_url = f"{request.host_url}uploads/{unique_filename}"
            return jsonify({'filename': unique_filename, 'audioUrl': audio_url}), 200
        except Exception as e:
            app.logger.error(f"File save error: {e}")
            return jsonify({'error': 'Failed to save file'}), 500
    return jsonify({'error': 'File type not allowed'}), 400

@app.route('/api/room/<string:room_code>/add-upload', methods=['POST'])
def add_upload_to_playlist(room_code):
    room_code = room_code.upper()
    try:
        data = request.get_json()
        room_key = f"room:{room_code}"
        room_data_json = r.get(room_key)
        if not room_data_json: return jsonify({'error': 'Room not found'}), 404
        
        room_data = json.loads(room_data_json)
        new_track = {
            'name': data.get('title', 'Unknown Title'), 
            'artist': data.get('artist', 'Unknown Artist'), 
            'albumArt': None, 
            'isUpload': True, 
            'audioUrl': data.get('audioUrl')
        }
        room_data['playlist'].append(new_track)
        r.set(room_key, json.dumps(room_data), ex=86400)
        socketio.emit('refresh_playlist', to=room_code)
        return jsonify({'message': 'Track added', 'track': new_track}), 200
    except Exception as e:
        return jsonify({'error': str(e)}), 500

@app.route('/api/lyrics/<string:video_id>')
def get_lyrics(video_id):
    try:
        cache_key = f"lyrics:v2:{video_id}" 
        cached_lyrics = r.get(cache_key)
        if cached_lyrics: return jsonify(json.loads(cached_lyrics))
    except redis.exceptions.ConnectionError:
        pass

    lyrics_json = []
    if lrc_kit_available:
        try:
            result = parse_lyrics(f"https://www.youtube.com/watch?v={video_id}")
            if isinstance(result, tuple) and len(result) >= 2 and result[0]:
                for line in result[0]:
                    if hasattr(line, 'time') and hasattr(line, 'text') and line.text.strip():
                        lyrics_json.append({'time': line.time, 'text': line.text})
        except Exception as e: 
            app.logger.error(f"lrc_kit error: {e}")

    try:
        r.set(cache_key, json.dumps(lyrics_json), ex=86400)
    except redis.exceptions.ConnectionError:
        pass
        
    return jsonify(lyrics_json)

# --- SOCKETIO HANDLERS ---
@socketio.on('join_room')
def handle_join_room(data):
    room_code = data.get('room_code', '').upper()
    username = data.get('username', 'Guest')
    sid = request.sid
    
    if not room_code: return
    
    try:
        room_key = f"room:{room_code}"
        room_data_json = r.get(room_key)
        if not room_data_json: 
            emit('error', {'message': 'Room not found'})
            return
            
        room_data = json.loads(room_data_json)
        join_room(room_code)
        
        # Determine admin status securely
        is_admin = False
        if not room_data.get('users'):
            is_admin = True
            room_data['admin_sid'] = sid
        elif room_data.get('admin_sid') == sid:
            is_admin = True
            
        room_data['users'][sid] = {'name': username, 'isAdmin': is_admin}
        r.set(room_key, json.dumps(room_data), ex=86400)
        
        emit('load_current_state', room_data['current_state'], to=sid)
        emit('update_user_list', list(room_data['users'].values()), to=room_code)
        app.logger.info(f"User {username} joined room {room_code}. Admin: {is_admin}")
    except redis.exceptions.ConnectionError:
        emit('error', {'message': 'Database error'})

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code = data.get('room_code', '').upper()
    if not room_code: return
    
    sid = request.sid
    try:
        room_key = f"room:{room_code}"
        room_data_json = r.get(room_key)
        if not room_data_json: return
        
        room_data = json.loads(room_data_json)
        
        # Authorization check
        if room_data.get('admin_sid') != sid and not room_data['current_state'].get('isCollaborative', False):
            return
    
        # --- HIGH-PRECISION SYNC LOGIC ---
        client_state = data.get('state', {})
        
        # Update server state with client's authoritative data (track, play status, etc.)
        room_data['current_state'].update(client_state)
        
        # Time Synchronization Logic
        client_timestamp = client_state.get('timestamp', 0)
        server_receive_time = time.time()
        
        # If playing, project currentTime forward based on one-way latency
        if client_timestamp > 0 and room_data['current_state'].get('isPlaying', False):
            latency = server_receive_time - client_timestamp
            # Sanity check: ignore huge latency spikes (>2s) that mess up projection
            if 0 < latency < 2.0:
                current_time = room_data['current_state'].get('currentTime', 0)
                room_data['current_state']['currentTime'] = current_time + latency
        
        # Stamp with server time for clients to calculate their own latency
        room_data['current_state']['serverTimestamp'] = server_receive_time
        # --- END SYNC LOGIC ---
    
        r.set(room_key, json.dumps(room_data), ex=86400)
        
        # Broadcast to everyone ELSE in the room
        emit('sync_player_state', room_data['current_state'], to=room_code, include_self=False)
        
    except Exception as e:
        app.logger.error(f"Error in update_player_state: {e}")

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    try:
        # Scan is inefficient but necessary without separate user-room mapping
        for key in r.scan_iter("room:*"):
            room_data_str = r.get(key)
            if not room_data_str: continue
            
            try:
                room_data = json.loads(room_data_str)
                if sid in room_data.get('users', {}):
                    room_code = key.split(":")[1]
                    del room_data['users'][sid]
                    
                    # Handle admin transfer
                    if room_data.get('admin_sid') == sid:
                        room_data['admin_sid'] = None
                        if room_data['users']:
                            new_admin_sid = next(iter(room_data['users']))
                            room_data['admin_sid'] = new_admin_sid
                            room_data['users'][new_admin_sid]['isAdmin'] = True
                            
                    # Save or delete room
                    if not room_data['users']:
                        r.delete(key)
                    else:
                        r.set(key, json.dumps(room_data), ex=86400)
                        emit('update_user_list', list(room_data['users'].values()), to=room_code)
                    break
            except json.JSONDecodeError: continue
    except redis.exceptions.ConnectionError:
        pass

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s - %(name)s - %(levelname)s - %(message)s')
    port = int(os.environ.get("PORT", 5001))
    app.logger.info(f"=== Starting MoodSync Backend on port {port} ===")
    app.logger.info(f"CORS allowed for: {FRONTEND_ORIGIN}")
    socketio.run(app, debug=True, use_reloader=False, host='0.0.0.0', port=port)