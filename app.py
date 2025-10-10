# moodsync/app.py - Fixed version with proper lrc_kit import, improved caching/playlist logic, and FILE UPLOAD SUPPORT

import os, base64, random, string, logging, time, requests, json
from functools import lru_cache
from flask import Flask, jsonify, request, send_from_directory, url_for # ADDED url_for, send_from_directory
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
from googleapiclient.discovery import build
from googleapiclient import errors
import redis
from werkzeug.utils import secure_filename
import mimetypes

# Try different import patterns for lrc_kit
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

# Use the environment variable for CORS
cors_origin = os.getenv("CORS_ALLOWED_ORIGIN", "*") 
CORS(app, origins=cors_origin)

app.secret_key = os.urandom(24)

# Also use it for SocketIO
socketio = SocketIO(app, cors_allowed_origins=cors_origin)

UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'mp3', 'wav', 'ogg', 'm4a', 'flac'}
MAX_FILE_SIZE = 50 * 1024 * 1024  # 50MB

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
    app.logger.error(f"FATAL: Could not connect to Redis. Error: {e}")
    exit(1)

# --- GLOBAL CONFIG & FALLBACKS ---
spotify_token_cache = {'token': None, 'expires': 0}
token_failure_count, last_token_failure = 0, 0
GENRE_CONFIGS = {
    'deep-house': {'seeds': ['deep-house', 'minimal-techno']}, 'house': {'seeds': ['house', 'dance']},
    'progressive-house': {'seeds': ['progressive-house', 'edm']}, 'tech-house': {'seeds': ['tech-house', 'techno']},
    'techno': {'seeds': ['techno', 'hardstyle', 'industrial']}, 
    'minimal-techno': {'seeds': ['minimal-techno', 'ambient', 'electronic']}, # Added 'electronic' for stability
    'detroit-techno': {'seeds': ['detroit-techno', 'techno']}, 'electronica': {'seeds': ['electronica', 'idm']},
    'edm': {'seeds': ['edm', 'electro', 'dance']}, 'electro': {'seeds': ['electro', 'chicago-house']},
    'dubstep': {'seeds': ['dubstep', 'bass-music']}, 'indie': {'seeds': ['indie', 'indie-pop', 'alternative']},
    'indie-pop': {'seeds': ['indie-pop', 'pop']}, 'alternative': {'seeds': ['alternative', 'rock']},
    'boiler-room': {'search_query': 'Boiler Room set'}, 'live-techno-set': {'search_query': 'live techno set'},
    'deep-house-mix': {'search_query': 'deep house mix'}, 'default': {'seeds': ['music', 'pop']}
}
FALLBACK_PLAYLIST = [
    {'name': 'Blinding Lights', 'artist': 'The Weeknd', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36', 'youtubeId': '4NRXx6U8ABQ'},
    {'name': 'As It Was', 'artist': 'Harry Styles', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b273b46f74097652c7f3a3a08237', 'youtubeId': 'H5v3kku4y6Q'},
    {'name': 'Levitating', 'artist': 'Dua Lipa', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b273bd2a8d3e3831753690453535', 'youtubeId': 'TUVcZfQe-Kw'},
    {'name': 'Shape of You', 'artist': 'Ed Sheeran', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b273ba5db46f4b838ef6027e6f96', 'youtubeId': 'JGwWNGJdvx8'},
    {'name': 'Someone You Loved', 'artist': 'Lewis Capaldi', 'albumArt': 'https://i.scdn.co/image/ab67616d0000b2733e55c33831f2f277d248f2f2', 'youtubeId': 'bCuhuePlP8o'}
]

# --- API FUNCTIONS ---
@lru_cache(maxsize=1)
def get_spotify_credentials(): return os.getenv('SPOTIFY_CLIENT_ID'), os.getenv('SPOTIFY_CLIENT_SECRET')

def get_spotify_token():
    global token_failure_count, last_token_failure
    if token_failure_count >= 3 and time.time() - last_token_failure < 300: return None
    if time.time() < spotify_token_cache['expires'] and spotify_token_cache['token']: return spotify_token_cache['token']
    client_id, client_secret = get_spotify_credentials()
    if not client_id or not client_secret: return None
    try:
        auth_str = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        response = requests.post("https://accounts.spotify.com/api/token", headers={"Authorization": f"Basic {auth_str}", "Content-Type": "application/x-www-form-urlencoded"}, data={"grant_type": "client_credentials"}, timeout=10)
        if response.status_code != 200: token_failure_count += 1; last_token_failure = time.time(); return None
        data = response.json()
        if 'access_token' not in data: token_failure_count += 1; last_token_failure = time.time(); return None
        spotify_token_cache['token'] = data['access_token']
        spotify_token_cache['expires'] = time.time() + data.get('expires_in', 3600) - 60
        token_failure_count = 0
        return data['access_token']
    except Exception: token_failure_count += 1; last_token_failure = time.time(); return None

def get_youtube_video_id_fallback(query):
    """Fallback to a public Invidious API if the official YouTube API fails."""
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
    cache_key = f"youtube:v2:{song_name}_{artist_name}".lower().replace(' ', '_')
    cached_id = r.get(cache_key)
    if cached_id: return None if cached_id == "none" else cached_id
    
    youtube_api_key = os.getenv('YOUTUBE_API_KEY')
    video_id = None
    query = f"{song_name} {artist_name} official audio"
    
    if youtube_api_key:
        try:
            youtube = build('youtube', 'v3', developerKey=youtube_api_key)
            search_request = youtube.search().list(q=query, part='snippet', maxResults=1, type='video', videoCategoryId='10')
            response = search_request.execute()
            video_id = response['items'][0]['id']['videoId'] if response.get('items') else None
        except errors.HttpError as e:
            if 'quotaExceeded' in str(e): app.logger.error(f"YOUTUBE QUOTA EXCEEDED. Trying fallback.")
            else: app.logger.error(f"YouTube search error for '{query}': {e}")
            video_id = None
        except Exception as e:
            app.logger.error(f"General YouTube API error for '{query}': {e}")
            video_id = None

    if not video_id:
        app.logger.info(f"Using Invidious fallback search for '{query}'")
        video_id = get_youtube_video_id_fallback(query)

    r.set(cache_key, video_id if video_id else "none", ex=86400 * 7)
    return video_id

def generate_playlist(genre):
    try:
        config = GENRE_CONFIGS.get(genre, GENRE_CONFIGS['default'])
        tracks, token = [], get_spotify_token()
        if not token: return FALLBACK_PLAYLIST
        if 'search_query' in config:
            params = {'q': config['search_query'], 'type': 'track', 'limit': 30, 'market': 'US'}
            response = requests.get("https://api.spotify.com/v1/search", headers={"Authorization": f"Bearer {token}"}, params=params)
        else:
            seeds = random.sample(config['seeds'], min(2, len(config['seeds'])))
            params = {'seed_genres': ','.join(seeds), 'limit': 30, 'market': 'US'}
            response = requests.get("https://api.spotify.com/v1/recommendations", headers={"Authorization": f"Bearer {token}"}, params=params)
        response.raise_for_status()
        tracks = response.json().get('tracks', {}).get('items', []) or response.json().get('tracks', [])
        if not tracks: raise Exception(f"No tracks found for genre: {genre}")
        tracks.sort(key=lambda x: x.get('popularity', 0), reverse=True)
        playlist = []
        for track in tracks:
            if len(playlist) >= 15: break
            song_name, artist_name = track.get('name'), track.get('artists', [{}])[0].get('name')
            if not song_name or not artist_name: continue
            video_id = get_youtube_video_id(song_name, artist_name)
            if video_id:
                album_art = track['album']['images'][0]['url'] if track.get('album', {}).get('images') else None
                playlist.append({'name': song_name, 'artist': artist_name, 'albumArt': album_art, 'youtubeId': video_id})
        if not playlist: raise Exception("No valid tracks found after YouTube processing.")
        return playlist
    except Exception as e:
        app.logger.warning(f"Playlist generation for '{genre}' failed: {e}. Using guaranteed fallback playlist.")
        return FALLBACK_PLAYLIST

# --- ROUTES & SOCKETS ---
@app.route('/generate', methods=['POST'])
def generate_route():
    data = request.get_json(); genre = data.get('mood', 'default').lower()
    playlist = generate_playlist(genre)
    while True:
        room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{room_code}"): break
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
            'equalizer': {'bass': 0, 'mids': 0, 'treble': 0}
        }, 
        'created_at': time.time()
    }
    
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    app.logger.info(f"Room {room_code} created.")
    return jsonify({'room_code': room_code}), 200

@app.route('/api/room/<string:room_code>')
def get_room_data(room_code):
    room_code = room_code.upper(); room_data_json = r.get(f"room:{room_code}")
    if not room_data_json: return jsonify({'error': 'Room not found'}), 404
    room_data = json.loads(room_data_json)
    return jsonify({'playlist_title': room_data['title'], 'playlist': room_data['playlist']}), 200

# --- NEW FILE UPLOAD AND PLAYLIST ROUTES ---

@app.route('/uploads/<filename>')
def uploaded_file(filename):
    """Serves uploaded files from the UPLOAD_FOLDER."""
    safe_filename = secure_filename(filename)
    # Important: Use the actual directory, not the app_config value
    return send_from_directory(UPLOAD_FOLDER, safe_filename)

@app.route('/api/upload', methods=['POST'])
def upload_file_route():
    """Handles file upload and returns the unique path."""
    if 'file' not in request.files:
        return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No selected file'}), 400
    
    if file and allowed_file(file.filename):
        if request.content_length > app.config['MAX_CONTENT_LENGTH']:
            return jsonify({'error': 'File too large (max 50MB)'}), 413
            
        filename = secure_filename(file.filename)
        # Use a unique identifier to prevent overwriting and ensure security
        unique_filename = f"{os.urandom(8).hex()}_{filename}"
        file_path = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        
        try:
            file.save(file_path)
            # Use url_for to generate the full, external URL for the client
            audio_url = url_for('uploaded_file', filename=unique_filename, _external=True)
            app.logger.info(f"File uploaded: {unique_filename}, URL: {audio_url}")
            return jsonify({
                'filename': unique_filename,
                'audioUrl': audio_url
            }), 200
        except Exception as e:
            app.logger.error(f"File save error: {e}")
            return jsonify({'error': 'Failed to save file'}), 500
    
    return jsonify({'error': 'File type not allowed'}), 400

@app.route('/api/room/<string:room_code>/add-upload', methods=['POST'])
def add_upload_to_playlist(room_code):
    """Adds an uploaded track to the room playlist and broadcasts the update."""
    room_code = room_code.upper()
    data = request.get_json()
    filename = data.get('filename')
    title = data.get('title')
    artist = data.get('artist')
    audio_url = data.get('audioUrl') # Now using the audioUrl from client
    
    room_data_json = r.get(f"room:{room_code}")
    if not room_data_json:
        return jsonify({'error': 'Room not found'}), 404
        
    room_data = json.loads(room_data_json)
    
    # Check if a track with the same filename (or audioUrl) already exists to avoid duplicates
    if any(track.get('audioUrl') == audio_url for track in room_data['playlist']):
        return jsonify({'message': 'Track already in playlist'}), 200

    new_track = {
        'name': title,
        'artist': artist,
        'albumArt': None,
        'youtubeId': None,
        'isUpload': True,
        'audioUrl': audio_url # Use the URL provided by the client's upload response
    }
    
    room_data['playlist'].append(new_track)
    
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    
    # Notify all clients in the room to refresh their playlist
    socketio.emit('refresh_playlist', to=room_code)
    
    # Return the new track to the client for immediate local update
    return jsonify({'message': 'Track added', 'track': new_track}), 200

# --- END NEW FILE UPLOAD AND PLAYLIST ROUTES ---

@app.route('/api/lyrics/<string:video_id>')
def get_lyrics(video_id):
    app.logger.info(f"--- LYRICS ENDPOINT HIT for video_id: {video_id} ---")
    
    # --- CACHE BUSTING ---
    # By changing the key name, we invalidate all old, potentially bad cache entries.
    cache_key = f"lyrics:v2:{video_id}" 
    
    cached_lyrics = r.get(cache_key)
    if cached_lyrics:
        app.logger.info(f"--- Found valid cached lyrics for {video_id} with new key ---")
        return jsonify(json.loads(cached_lyrics))

    app.logger.info(f"--- No valid cache found for {video_id}. Fetching new lyrics. ---")
    lyrics_json = []
    
    # Method 1: Try lrc_kit first
    if lrc_kit_available:
        try:
            app.logger.info(f"--- Attempting lrc_kit for {video_id} ---")
            youtube_url = f"https://www.youtube.com/watch?v={video_id}"
            result = parse_lyrics(youtube_url)
            
            if isinstance(result, tuple) and len(result) >= 2:
                lyrics_list, metadata = result
                if lyrics_list:
                    for line in lyrics_list:
                        if hasattr(line, 'time') and hasattr(line, 'text') and line.text.strip():
                            lyrics_json.append({'time': line.time, 'text': line.text})
                    if lyrics_json:
                        app.logger.info(f"--- lrc_kit found live lyrics for {video_id} ---")
        except Exception as e:
            app.logger.error(f"--- lrc_kit error for {video_id}: {e} ---")
    
    # Method 2: Demo lyrics (Fallback Logic)
    if not lyrics_json:
        app.logger.info(f"--- Live lyrics not found. Checking for demo lyrics for {video_id}. ---")
        demo_lyrics = {
            "4NRXx6U8ABQ": [{"time": 1, "text": "[Demo] I'm blinded by the lights"}, {"time": 6, "text": "No, I can't sleep until I feel your touch"}],
            "H5v3kku4y6Q": [{"time": 1, "text": "[Demo] Come on, Harry, we wanna say goodnight to you!"}, {"time": 7, "text": "Holdin' me back"}],
            "TUVcZfQe-Kw": [{"time": 1, "text": "[Demo] If you wanna run away with me, I know a galaxy"}, {"time": 6, "text": "And I could take you for a ride"}],
            "JGwWNGJdvx8": [{"time": 1, "text": "[Demo] The club isn't the best place to find a lover"}, {"time": 6, "text": "So the bar is where I go"}],
            "bCuhuePlP8o": [{"time": 1, "text": "[Demo] I'm going under and this time I fear there's no one to save me"}, {"time": 7, "text": "This all or nothing really got a way of driving me crazy"}]
        }
        
        if video_id in demo_lyrics:
            lyrics_json = demo_lyrics[video_id]
            app.logger.info(f"--- Using demo lyrics for {video_id}. ---")
    
    # Cache the final result with the new key
    r.set(cache_key, json.dumps(lyrics_json), ex=86400)
    
    app.logger.info(f"--- Returning {len(lyrics_json)} lyrics lines for {video_id}. ---")
    return jsonify(lyrics_json)

@socketio.on('join_room')
def handle_join_room(data):
    room_code = data['room_code'].upper(); username = data.get('username', 'Guest'); sid = request.sid
    room_data_json = r.get(f"room:{room_code}")
    if not room_data_json: emit('error', {'message': 'Room not found'}); return
    room_data = json.loads(room_data_json); join_room(room_code)
    is_admin = not room_data.get('admin_sid') or not room_data.get('users')
    if is_admin: room_data['admin_sid'] = sid
    room_data['users'][sid] = {'name': username, 'isAdmin': is_admin}
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    emit('load_current_state', room_data['current_state'], to=sid)
    emit('update_user_list', list(room_data['users'].values()), to=room_code)
    app.logger.info(f"User '{username}' ({sid}) joined room {room_code}. Admin: {is_admin}")

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code = data['room_code'].upper(); sid = request.sid
    room_data_json = r.get(f"room:{room_code}");
    if not room_data_json: return
    room_data = json.loads(room_data_json)
    # CRITICAL: Admin check to prevent non-admins from controlling the room
    if room_data.get('admin_sid') != sid and not room_data['current_state'].get('isCollaborative', False):
         app.logger.warning(f"Non-admin/non-collaborative user {sid} tried to update state in {room_code}")
         return
         
    room_data['current_state'].update(data['state'])
    room_data['current_state']['timestamp'] = time.time()
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    emit('sync_player_state', data['state'], to=room_code, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    for key in r.scan_iter("room:*"):
        try:
            room_data_str = r.get(key)
            if not room_data_str: continue
            room_data = json.loads(room_data_str)
            if sid in room_data.get('users', {}):
                room_code = key.split(":")[1]; user_name = room_data['users'][sid]['name']
                del room_data['users'][sid]
                if room_data.get('admin_sid') == sid:
                    if room_data['users']:
                        new_admin_sid = next(iter(room_data['users'])); room_data['admin_sid'] = new_admin_sid
                        room_data['users'][new_admin_sid]['isAdmin'] = True
                    else: room_data['admin_sid'] = None
                r.set(key, json.dumps(room_data), ex=86400)
                emit('update_user_list', list(room_data['users'].values()), to=room_code)
                app.logger.info(f"User '{user_name}' disconnected from room {room_code}")
                break
        except (json.JSONDecodeError, TypeError): continue

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')
    app.logger.info("=== Starting MoodSync API Server (Fixed Version) ===")
    if lrc_kit_available:
        app.logger.info("✅ Lyrics functionality enabled")
    else:
        app.logger.warning("❌ Lyrics functionality disabled - lrc_kit not available")
    socketio.run(app, debug=True, use_reloader=False, host='0.0.0.0', port=5001)