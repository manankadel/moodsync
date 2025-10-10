# moodsync/app.py - Optimized for 500MB uploads and mass concurrent sync

import os, base64, random, string, logging, time, requests, json
from functools import lru_cache
from flask import Flask, jsonify, request, send_file
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
from googleapiclient.discovery import build
from googleapiclient import errors
import redis
from werkzeug.utils import secure_filename
import mimetypes
from collections import defaultdict

load_dotenv()
app = Flask(__name__)

cors_origin = os.getenv("CORS_ALLOWED_ORIGIN", "*") 
CORS(app, origins=cors_origin)

app.secret_key = os.urandom(24)

# Socket.IO with ultra-low latency config for mass concurrent connections
socketio = SocketIO(
    app, 
    cors_allowed_origins=cors_origin,
    async_mode='threading',
    ping_interval=2,  # Keep-alive every 2s
    ping_timeout=5,   # Timeout after 5s
    max_http_buffer_size=500 * 1024 * 1024  # 500MB
)

UPLOAD_FOLDER = 'uploads'
ALLOWED_EXTENSIONS = {'mp3', 'wav', 'ogg', 'm4a', 'flac'}
MAX_FILE_SIZE = 500 * 1024 * 1024  # 500MB

os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = MAX_FILE_SIZE

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in ALLOWED_EXTENSIONS

# Redis connection with optimized settings
try:
    redis_url = os.getenv('REDIS_URL', 'redis://localhost:6379')
    r = redis.from_url(
        redis_url, 
        decode_responses=True,
        socket_connect_timeout=3,
        socket_keepalive=True,
        socket_keepalive_options={},
        connection_pool_kwargs={'max_connections': 100}
    )
    r.ping()
    app.logger.info(f"Redis connected at {redis_url}")
except redis.exceptions.ConnectionError as e:
    app.logger.error(f"FATAL: Redis connection failed: {e}")
    exit(1)

# Track sync state per room for perfect multi-user sync
room_sync_state = defaultdict(dict)

spotify_token_cache = {'token': None, 'expires': 0}
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

@lru_cache(maxsize=1)
def get_spotify_credentials(): 
    return os.getenv('SPOTIFY_CLIENT_ID'), os.getenv('SPOTIFY_CLIENT_SECRET')

def get_spotify_token():
    if time.time() < spotify_token_cache['expires'] and spotify_token_cache['token']: 
        return spotify_token_cache['token']
    
    client_id, client_secret = get_spotify_credentials()
    if not client_id or not client_secret: 
        return None
    
    try:
        auth_str = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        response = requests.post(
            "https://accounts.spotify.com/api/token",
            headers={"Authorization": f"Basic {auth_str}", "Content-Type": "application/x-www-form-urlencoded"},
            data={"grant_type": "client_credentials"},
            timeout=5
        )
        if response.status_code != 200:
            return None
        data = response.json()
        if 'access_token' not in data:
            return None
        spotify_token_cache['token'] = data['access_token']
        spotify_token_cache['expires'] = time.time() + data.get('expires_in', 3600) - 60
        return data['access_token']
    except Exception as e:
        app.logger.error(f"Spotify token error: {e}")
        return None

def get_youtube_video_id(song_name, artist_name):
    cache_key = f"youtube:v2:{song_name}_{artist_name}".lower().replace(' ', '_')
    cached_id = r.get(cache_key)
    if cached_id: 
        return None if cached_id == "none" else cached_id
    
    youtube_api_key = os.getenv('YOUTUBE_API_KEY')
    video_id = None
    
    if youtube_api_key:
        try:
            youtube = build('youtube', 'v3', developerKey=youtube_api_key)
            response = youtube.search().list(
                q=f"{song_name} {artist_name}", 
                part='snippet', 
                maxResults=1, 
                type='video'
            ).execute()
            video_id = response['items'][0]['id']['videoId'] if response.get('items') else None
        except Exception as e:
            app.logger.warning(f"YouTube search failed: {e}")
    
    r.set(cache_key, video_id if video_id else "none", ex=86400 * 7)
    return video_id

def generate_playlist(genre):
    try:
        config = GENRE_CONFIGS.get(genre, GENRE_CONFIGS['default'])
        token = get_spotify_token()
        if not token: 
            return FALLBACK_PLAYLIST
        
        seeds = config.get('seeds', ['music'])[:2]
        params = {'seed_genres': ','.join(seeds), 'limit': 20, 'market': 'US'}
        response = requests.get(
            "https://api.spotify.com/v1/recommendations",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
            timeout=5
        )
        response.raise_for_status()
        tracks = response.json().get('tracks', [])
        
        if not tracks:
            return FALLBACK_PLAYLIST
        
        playlist = []
        for track in tracks[:15]:
            song_name = track.get('name')
            artist_name = track.get('artists', [{}])[0].get('name')
            if not song_name or not artist_name:
                continue
            video_id = get_youtube_video_id(song_name, artist_name)
            if video_id:
                album_art = track['album']['images'][0]['url'] if track.get('album', {}).get('images') else None
                playlist.append({
                    'name': song_name,
                    'artist': artist_name,
                    'albumArt': album_art,
                    'youtubeId': video_id
                })
        
        return playlist if playlist else FALLBACK_PLAYLIST
    except Exception as e:
        app.logger.warning(f"Playlist generation failed: {e}")
        return FALLBACK_PLAYLIST

# FILE UPLOAD - Optimized for 500MB
@app.route('/api/upload', methods=['POST'])
def upload_file():
    if 'file' not in request.files:
        return jsonify({'error': 'No file provided'}), 400
    
    file = request.files['file']
    if file.filename == '':
        return jsonify({'error': 'No file selected'}), 400
    
    if not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file type. Allowed: MP3, WAV, OGG, M4A, FLAC'}), 400
    
    try:
        filename = secure_filename(file.filename)
        unique_id = ''.join(random.choices(string.ascii_lowercase + string.digits, k=8))
        name, ext = os.path.splitext(filename)
        unique_filename = f"{name}_{unique_id}{ext}"
        
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], unique_filename)
        file.save(filepath)
        
        file_size = os.path.getsize(filepath) / (1024 * 1024)
        app.logger.info(f"File uploaded: {unique_filename} ({file_size:.1f}MB)")
        
        return jsonify({
            'success': True,
            'filename': unique_filename,
            'originalName': filename,
            'size': file_size
        }), 200
        
    except Exception as e:
        app.logger.error(f"Upload error: {e}")
        return jsonify({'error': 'Upload failed'}), 500

@app.route('/api/audio/<filename>')
def serve_audio(filename):
    try:
        filepath = os.path.join(app.config['UPLOAD_FOLDER'], secure_filename(filename))
        if not os.path.exists(filepath):
            return jsonify({'error': 'File not found'}), 404
        
        mimetype = mimetypes.guess_type(filepath)[0] or 'audio/mpeg'
        return send_file(filepath, mimetype=mimetype)
    except Exception as e:
        app.logger.error(f"Audio serving error: {e}")
        return jsonify({'error': 'Could not serve file'}), 500

@app.route('/api/room/<string:room_code>/add-upload', methods=['POST'])
def add_upload_to_playlist(room_code):
    room_code = room_code.upper()
    room_data_json = r.get(f"room:{room_code}")
    
    if not room_data_json:
        return jsonify({'error': 'Room not found'}), 404
    
    try:
        data = request.get_json()
        filename = data.get('filename')
        title = data.get('title', 'Uploaded Track')
        artist = data.get('artist', 'Unknown Artist')
        
        if not filename:
            return jsonify({'error': 'Filename required'}), 400
        
        track = {
            'name': title,
            'artist': artist,
            'albumArt': None,
            'youtubeId': None,
            'isUpload': True,
            'audioUrl': f'/api/audio/{filename}'
        }
        
        room_data = json.loads(room_data_json)
        room_data['playlist'].append(track)
        r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
        
        # Broadcast to all users in room
        socketio.emit('playlist_updated', {'track': track}, room=room_code)
        
        app.logger.info(f"Added upload to {room_code}: {title}")
        return jsonify({'success': True, 'track': track}), 200
        
    except Exception as e:
        app.logger.error(f"Error adding upload: {e}")
        return jsonify({'error': 'Failed to add to playlist'}), 500

# ROUTES
@app.route('/generate', methods=['POST'])
def generate_route():
    data = request.get_json()
    genre = data.get('mood', 'default').lower()
    playlist = generate_playlist(genre)
    
    room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    while r.exists(f"room:{room_code}"):
        room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
    
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
    app.logger.info(f"Room created: {room_code}")
    return jsonify({'room_code': room_code}), 200

@app.route('/api/room/<string:room_code>')
def get_room_data(room_code):
    room_code = room_code.upper()
    room_data_json = r.get(f"room:{room_code}")
    if not room_data_json:
        return jsonify({'error': 'Room not found'}), 404
    room_data = json.loads(room_data_json)
    return jsonify({'playlist_title': room_data['title'], 'playlist': room_data['playlist']}), 200

# PERFECT SYNC FOR MASS CONCURRENT USERS
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
    
    is_admin = not room_data.get('admin_sid') or not room_data.get('users')
    if is_admin:
        room_data['admin_sid'] = sid
    
    room_data['users'][sid] = {'name': username, 'isAdmin': is_admin}
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    
    emit('load_current_state', room_data['current_state'], to=sid)
    emit('update_user_list', list(room_data['users'].values()), to=room_code)
    
    app.logger.info(f"User joined: {username} ({sid}) - Admin: {is_admin}")

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code = data['room_code'].upper()
    sid = request.sid
    
    room_data_json = r.get(f"room:{room_code}")
    if not room_data_json:
        return
    
    room_data = json.loads(room_data_json)
    if room_data.get('admin_sid') != sid:
        return
    
    new_state = data['state']
    new_state['timestamp'] = time.time()
    
    room_data['current_state'].update(new_state)
    r.set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    
    # Broadcast to ALL users except sender (critical for mass sync)
    emit('sync_player_state', new_state, room=room_code, skip_sid=sid)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    for key in r.scan_iter("room:*"):
        try:
            room_data_str = r.get(key)
            if not room_data_str:
                continue
            room_data = json.loads(room_data_str)
            if sid in room_data.get('users', {}):
                room_code = key.split(":")[1]
                user_name = room_data['users'][sid]['name']
                del room_data['users'][sid]
                
                if room_data.get('admin_sid') == sid:
                    if room_data['users']:
                        new_admin_sid = next(iter(room_data['users']))
                        room_data['admin_sid'] = new_admin_sid
                        room_data['users'][new_admin_sid]['isAdmin'] = True
                    else:
                        room_data['admin_sid'] = None
                
                r.set(key, json.dumps(room_data), ex=86400)
                emit('update_user_list', list(room_data['users'].values()), room=room_code)
                app.logger.info(f"User disconnected: {user_name}")
                break
        except (json.JSONDecodeError, TypeError):
            continue

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')
    app.logger.info("MoodSync Server Starting - 500MB uploads, mass concurrent sync")
    socketio.run(app, debug=False, host='0.0.0.0', port=5001, allow_unsafe_werkzeug=True)