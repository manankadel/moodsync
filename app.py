import os, base64, random, string, logging, time, requests, json
from functools import lru_cache
from flask import Flask, jsonify, request, send_from_directory, url_for
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
from googleapiclient.discovery import build
from googleapiclient import errors
import redis
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# --- ROBUST CORS CONFIGURATION ---
frontend_url = os.getenv("FRONTEND_URL")
allowed_origins = ["http://localhost:3000"]
if frontend_url:
    allowed_origins.append(frontend_url)
    if "www." in frontend_url:
        allowed_origins.append(frontend_url.replace("www.", ""))
    elif "https://" in frontend_url:
        allowed_origins.append(frontend_url.replace("https://", "https://www."))
# --- END OF CORS CONFIGURATION ---

CORS(app, origins=allowed_origins, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins=allowed_origins, ping_timeout=60, ping_interval=25)

app.secret_key = os.urandom(24)
UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in {'mp3', 'wav', 'ogg', 'm4a', 'flac'}

try:
    redis_url = os.getenv('REDIS_URL')
    if not redis_url: raise ValueError("REDIS_URL environment variable not set.")
    r = redis.from_url(redis_url, decode_responses=True)
    r.ping()
    app.logger.info(f"Successfully connected to Redis at {redis_url.split('@')[-1]}")
except (redis.exceptions.ConnectionError, ValueError) as e:
    app.logger.error(f"FATAL: Could not connect to Redis. Error: {e}")
    exit(1)

lrc_kit_available = False
try:
    from lrc_kit.lrc import parse_lyrics
    lrc_kit_available = True
except ImportError:
    app.logger.warning("lrc_kit not found. Lyrics functionality will be disabled.")

@app.route('/ping', methods=['GET'])
def ping_pong():
    return jsonify({'serverTime': time.time()})

spotify_token_cache = {'token': None, 'expires': 0}
token_failure_count, last_token_failure = 0, 0

GENRE_CONFIGS = {
    'deep-house': {'seeds': ['deep-house', 'minimal-techno']}, 'house': {'seeds': ['house', 'dance']},
    'progressive-house': {'seeds': ['progressive-house', 'edm']}, 'tech-house': {'seeds': ['tech-house', 'techno']},
    'techno': {'seeds': ['techno', 'hardstyle', 'industrial']}, 'minimal-techno': {'seeds': ['minimal-techno', 'ambient', 'electronic']},
    'detroit-techno': {'seeds': ['detroit-techno', 'techno']}, 'electronica': {'seeds': ['electronica', 'idm']},
    'edm': {'seeds': ['edm', 'electro', 'dance']}, 'electro': {'seeds': ['electro', 'chicago-house']},
    'dubstep': {'seeds': ['dubstep', 'bass-music']}, 'indie': {'seeds': ['indie', 'indie-pop', 'alternative']},
    'indie-pop': {'seeds': ['indie-pop', 'pop']}, 'alternative': {'seeds': ['alternative', 'rock']},
    'boiler-room': {'search_query': 'Boiler Room set'}, 'live-techno-set': {'search_query': 'live techno set'},
    'deep-house-mix': {'search_query': 'deep house mix'}, 'default': {'seeds': ['music', 'pop']}
}

FALLBACK_PLAYLIST = [
    {'name': 'Blinding Lights', 'artist': 'The Weeknd', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36', 'youtubeId': '4NRXx6U8ABQ'},
    {'name': 'As It Was', 'artist': 'Harry Styles', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b27346f74097652c7f3a3a08237', 'youtubeId': 'H5v3kku4y6Q'},
]

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
        return None
    try:
        auth_str = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        response = requests.post("https://accounts.spotify.com/api/token", headers={"Authorization": f"Basic {auth_str}", "Content-Type": "application/x-www-form-urlencoded"}, data={"grant_type": "client_credentials"}, timeout=10)
        response.raise_for_status()
        data = response.json()
        if 'access_token' not in data: 
            token_failure_count += 1
            last_token_failure = time.time()
            return None
        spotify_token_cache['token'] = data['access_token']
        spotify_token_cache['expires'] = time.time() + data.get('expires_in', 3600) - 60
        token_failure_count = 0
        return data['access_token']
    except Exception as e:
        app.logger.error(f"Spotify token error: {e}")
        token_failure_count += 1
        last_token_failure = time.time()
        return None

def get_youtube_video_id(song_name, artist_name):
    cache_key = f"youtube:v2:{song_name}_{artist_name}".lower().replace(' ', '_')
    try:
        cached_id = r.get(cache_key)
        if cached_id: 
            return None if cached_id == "none" else cached_id
    except redis.exceptions.ConnectionError: 
        pass
    youtube_api_key = os.getenv('YOUTUBE_API_KEY')
    query = f"{song_name} {artist_name} official audio"
    video_id = None
    if youtube_api_key:
        try:
            youtube = build('youtube', 'v3', developerKey=youtube_api_key)
            req = youtube.search().list(q=query, part='snippet', maxResults=1, type='video', videoCategoryId='10')
            res = req.execute()
            video_id = res['items'][0]['id']['videoId'] if res.get('items') else None
        except Exception as e: 
            app.logger.error(f"YouTube API Error: {e}")
    if not video_id:
        try:
            res = requests.get(f"https://invidious.io.gg/api/v1/search?q={query}", timeout=10).json()
            video_id = res[0].get('videoId') if res and isinstance(res, list) else None
        except Exception as e: 
            app.logger.error(f"Invidious fallback failed: {e}")
    try: 
        r.set(cache_key, video_id if video_id else "none", ex=86400 * 7)
    except redis.exceptions.ConnectionError: 
        pass
    return video_id

def generate_playlist(genre):
    try:
        config = GENRE_CONFIGS.get(genre, GENRE_CONFIGS['default'])
        token = get_spotify_token()
        if not token: 
            app.logger.warning("No Spotify token, using fallback")
            return FALLBACK_PLAYLIST
        if 'search_query' in config:
            params = {'q': config['search_query'], 'type': 'track', 'limit': 30, 'market': 'US'}
            response = requests.get("https://api.spotify.com/v1/search", headers={"Authorization": f"Bearer {token}"}, params=params, timeout=10)
        else:
            seeds = random.sample(config['seeds'], min(2, len(config['seeds'])))
            params = {'seed_genres': ','.join(seeds), 'limit': 30, 'market': 'US'}
            response = requests.get("https://api.spotify.com/v1/recommendations", headers={"Authorization": f"Bearer {token}"}, params=params, timeout=10)
        response.raise_for_status()
        tracks = response.json().get('tracks', {}).get('items', []) or response.json().get('tracks', [])
        if not tracks: 
            raise Exception(f"No tracks for genre: {genre}")
        playlist = []
        for track in sorted(tracks, key=lambda x: x.get('popularity', 0), reverse=True):
            if len(playlist) >= 15: 
                break
            song_name = track.get('name')
            artist_name = track.get('artists', [{}])[0].get('name')
            if song_name and artist_name:
                video_id = get_youtube_video_id(song_name, artist_name)
                if video_id:
                    album_images = track.get('album', {}).get('images', [])
                    album_art = album_images[0]['url'] if album_images else None
                    playlist.append({'name': song_name, 'artist': artist_name, 'albumArt': album_art, 'youtubeId': video_id})
        if not playlist: 
            raise Exception("No valid tracks after YouTube processing.")
        return playlist
    except Exception as e:
        app.logger.warning(f"Playlist generation for '{genre}' failed: {e}. Using fallback.")
        return FALLBACK_PLAYLIST

@app.route('/generate', methods=['POST', 'OPTIONS'])
def generate_route():
    if request.method == 'OPTIONS': 
        return '', 204
    data = request.get_json()
    genre = data.get('mood', 'default').lower()
    
    app.logger.info(f"Generating playlist for genre: {genre}")
    playlist = generate_playlist(genre)
    app.logger.info(f"Generated {len(playlist)} tracks")
    
    while True:
        room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{room_code}"): 
            break
    
    title = genre.replace('-', ' ').title() if genre != 'default' else "Curated Vibes"
    room_data = {
        'playlist': playlist, 'title': title, 'users': {}, 'admin_sid': None,
        'current_state': {
            'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'volume': 80, 
            'timestamp': time.time(), 'serverTimestamp': time.time(), 
            'equalizer': {'bass': 0, 'mids': 0, 'treble': 0}, 'isCollaborative': False
        },
        'created_at': time.time()
    }
    
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    app.logger.info(f"Room {room_code} created with {len(playlist)} tracks")
    
    return jsonify({'room_code': room_code}), 200

@app.route('/api/room/<string:room_code>')
def get_room_data(room_code):
    room_code = room_code.upper()
    room_data_json = r.get(f"room:{room_code}")
    if not room_data_json: 
        return jsonify({'error': 'Room not found'}), 404
    room_data = json.loads(room_data_json)
    return jsonify({'playlist_title': room_data['title'], 'playlist': room_data['playlist']}), 200

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    return send_from_directory(UPLOAD_FOLDER, secure_filename(filename))

@app.route('/api/upload', methods=['POST'])
def upload_file_route():
    if 'file' not in request.files: return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '': return jsonify({'error': 'No selected file'}), 400
    if file and allowed_file(file.filename):
        filename = f"{os.urandom(8).hex()}_{secure_filename(file.filename)}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], filename)
        try:
            file.save(file_path)
            audio_url = url_for('uploaded_file', filename=filename, _external=True)
            return jsonify({'filename': filename, 'audioUrl': audio_url}), 200
        except Exception as e:
            app.logger.error(f"File save error: {e}")
            return jsonify({'error': 'Failed to save file'}), 500
    return jsonify({'error': 'File type not allowed'}), 400

@app.route('/api/room/<string:room_code>/add-upload', methods=['POST'])
def add_upload_to_playlist(room_code):
    room_code = room_code.upper()
    data = request.get_json()
    room_data_json = r.get(f"room:{room_code}")
    if not room_data_json: return jsonify({'error': 'Room not found'}), 404
    room_data = json.loads(room_data_json)
    new_track = {'name': data.get('title'), 'artist': data.get('artist'), 'albumArt': None, 'youtubeId': None, 'isUpload': True, 'audioUrl': data.get('audioUrl')}
    room_data['playlist'].append(new_track)
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    socketio.emit('refresh_playlist', to=room_code)
    return jsonify({'message': 'Track added', 'track': new_track}), 200

@app.route('/api/lyrics/<string:video_id>')
def get_lyrics(video_id):
    cache_key = f"lyrics:v2:{video_id}"
    try:
        cached_lyrics = r.get(cache_key)
        if cached_lyrics: return jsonify(json.loads(cached_lyrics))
    except redis.exceptions.ConnectionError: pass
    lyrics_json = []
    if lrc_kit_available:
        try:
            result = parse_lyrics(f"https://www.youtube.com/watch?v={video_id}")
            if isinstance(result, tuple) and len(result) >= 2 and result[0]:
                for line in result[0]:
                    if hasattr(line, 'time') and hasattr(line, 'text') and line.text.strip():
                        lyrics_json.append({'time': line.time, 'text': line.text})
        except Exception as e: app.logger.error(f"lrc_kit error: {e}")
    try: 
        r.set(cache_key, json.dumps(lyrics_json), ex=86400)
    except redis.exceptions.ConnectionError: pass
    return jsonify(lyrics_json)

@socketio.on('join_room')
def handle_join_room(data):
    room_code = data['room_code'].upper()
    username = data.get('username', 'Guest')
    sid = request.sid
    room_data_json = r.get(f"room:{room_code}")
    if not room_data_json: 
        emit('error', {'message': 'Room not found'})
        return
    room_data = json.loads(room_data_json)
    join_room(room_code)
    is_admin = not room_data.get('users') or not room_data.get('admin_sid')
    if is_admin: room_data['admin_sid'] = sid
    room_data['users'][sid] = {'name': username, 'isAdmin': is_admin}
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    emit('load_current_state', room_data['current_state'], to=sid)
    emit('update_user_list', list(room_data['users'].values()), to=room_code)
    app.logger.info(f"User {username} joined room {room_code} (admin: {is_admin})")

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code = data['room_code'].upper()
    sid = request.sid
    room_data_json = r.get(f"room:{room_code}")
    if not room_data_json: return
    room_data = json.loads(room_data_json)
    if room_data.get('admin_sid') != sid and not room_data['current_state'].get('isCollaborative', False): 
        return
    client_state = data['state']
    room_data['current_state'].update(client_state)
    client_timestamp = client_state.get('timestamp', 0)
    server_receive_time = time.time()
    if client_timestamp > 0 and client_state.get('isPlaying', False):
        latency = server_receive_time - client_timestamp
        if 0 < latency < 2.0: room_data['current_state']['currentTime'] += latency
    room_data['current_state']['serverTimestamp'] = server_receive_time
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    emit('sync_player_state', room_data['current_state'], to=room_code, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    for key in r.scan_iter("room:*"):
        try:
            room_data_str = r.get(key)
            if not room_data_str: continue
            room_data = json.loads(room_data_str)
            if sid in room_data.get('users', {}):
                room_code = key.split(":")[1]
                del room_data['users'][sid]
                if room_data.get('admin_sid') == sid:
                    if room_data['users']:
                        new_admin_sid = next(iter(room_data['users']))
                        room_data['admin_sid'] = new_admin_sid
                        room_data['users'][new_admin_sid]['isAdmin'] = True
                    else: 
                        room_data['admin_sid'] = None
                if room_data['users']:
                    r.set(key, json.dumps(room_data), ex=86400)
                    emit('update_user_list', list(room_data['users'].values()), to=room_code)
                else:
                    r.delete(key)
                break
        except (json.JSONDecodeError, TypeError): 
            continue

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')
    app.logger.info("=== Starting MoodSync API Server ===")
    app.logger.info(f"CORS allowed for: {allowed_origins}")
    socketio.run(app, debug=False, use_reloader=False, host='0.0.0.0', port=5001)