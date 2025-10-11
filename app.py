import os, random, string, logging, time, json
from flask import Flask, jsonify, request, send_from_directory, url_for
from flask_socketio import SocketIO, join_room, leave_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
import redis
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# --- CORS CONFIGURATION ---
frontend_url = os.getenv("FRONTEND_URL")
allowed_origins = ["http://localhost:3000"]
if frontend_url:
    allowed_origins.append(frontend_url)
# --- END OF CORS CONFIGURATION ---

CORS(app, origins=allowed_origins, supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins=allowed_origins, ping_timeout=60, ping_interval=25, async_mode='gevent')

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
    app.logger.error(f"FATAL: Could not connect to Redis. Aborting. Error: {e}")
    exit(1)

def safe_redis_get(key):
    try: return r.get(key)
    except redis.exceptions.ConnectionError as e: app.logger.error(f"Redis GET failed: {e}"); return None

def safe_redis_set(key, value, ex):
    try: r.set(key, value, ex=ex); return True
    except redis.exceptions.ConnectionError as e: app.logger.error(f"Redis SET failed: {e}"); return False

def safe_redis_delete(key):
    try: r.delete(key); return True
    except redis.exceptions.ConnectionError as e: app.logger.error(f"Redis DELETE failed: {e}"); return False

@app.route('/ping', methods=['GET'])
def ping_pong():
    return jsonify({'serverTime': time.time()})

@app.route('/generate', methods=['POST'])
def generate_route():
    while True:
        room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{room_code}"): break

    # Create a placeholder track to guide the user
    placeholder_playlist = [{
        'name': "Ready for your music!",
        'artist': "Upload a track to get started",
        'albumArt': None,
        'youtubeId': None,
        'isUpload': False, # Important: This is not a real upload
        'audioUrl': None
    }]

    room_data = {
        'playlist': placeholder_playlist,
        'title': "Shared Sonic Space",
        'users': {},
        'admin_sid': None,
        'current_state': {
            'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'volume': 80,
            'timestamp': time.time(), 'serverTimestamp': time.time(),
            'equalizer': {'bass': 0, 'mids': 0, 'treble': 0},
            'isCollaborative': True # Default to collaborative for simplicity
        },
        'created_at': time.time()
    }
    
    safe_redis_set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    app.logger.info(f"Room {room_code} created.")
    return jsonify({'room_code': room_code}), 200

@app.route('/api/room/<string:room_code>')
def get_room_data(room_code):
    room_data_json = safe_redis_get(f"room:{room_code.upper()}")
    if not room_data_json: return jsonify({'error': 'Room not found'}), 404
    room_data = json.loads(room_data_json)
    return jsonify({'playlist_title': room_data['title'], 'playlist': room_data['playlist']})

@app.route('/uploads/<path:filename>')
def uploaded_file(filename):
    safe_filename = secure_filename(filename)
    if '..' in safe_filename or safe_filename.startswith('/'):
        return jsonify({'error': 'Invalid filename pattern'}), 400
    try:
        return send_from_directory(os.path.abspath(UPLOAD_FOLDER), safe_filename)
    except FileNotFoundError:
        return jsonify({'error': 'File not found'}), 404

@app.route('/api/upload', methods=['POST'])
def upload_file_route():
    if 'file' not in request.files: return jsonify({'error': 'No file part'}), 400
    file = request.files['file']
    if file.filename == '' or not allowed_file(file.filename):
        return jsonify({'error': 'Invalid file'}), 400
        
    filename = f"{os.urandom(8).hex()}_{secure_filename(file.filename)}"
    try:
        file.save(os.path.join(app.config['UPLOAD_FOLDER'], filename))
        audio_url = url_for('uploaded_file', filename=filename, _external=True, _scheme=request.scheme)
        return jsonify({'filename': filename, 'audioUrl': audio_url}), 200
    except Exception as e:
        app.logger.error(f"File save error: {e}"); return jsonify({'error': 'Failed to save file'}), 500

@app.route('/api/room/<string:room_code>/add-upload', methods=['POST'])
def add_upload_to_playlist(room_code):
    room_code = room_code.upper()
    data = request.get_json()
    room_key = f"room:{room_code}"
    try:
        with r.pipeline() as pipe:
            while True:
                try:
                    pipe.watch(room_key)
                    room_data_json = pipe.get(room_key)
                    if not room_data_json: return jsonify({'error': 'Room not found'}), 404
                    room_data = json.loads(room_data_json)
                    new_track = {'name': data.get('title'), 'artist': data.get('artist'), 'albumArt': None, 'youtubeId': None, 'isUpload': True, 'audioUrl': data.get('audioUrl')}
                    
                    # If the only track is the placeholder, replace it. Otherwise, append.
                    if len(room_data['playlist']) == 1 and room_data['playlist'][0]['audioUrl'] is None:
                        room_data['playlist'] = [new_track]
                        # Reset track index to 0 for the new first song
                        room_data['current_state']['trackIndex'] = 0
                    else:
                        room_data['playlist'].append(new_track)
                        
                    pipe.multi()
                    pipe.set(room_key, json.dumps(room_data), ex=86400)
                    pipe.execute()
                    break
                except redis.exceptions.WatchError: continue
        socketio.emit('refresh_playlist', to=room_code)
        # If this was the first track added, tell clients to auto-play it
        if len(room_data['playlist']) == 1:
            room_data['current_state']['isPlaying'] = True
            socketio.emit('sync_player_state', room_data['current_state'], to=room_code)
        return jsonify({'message': 'Track added'}), 200
    except Exception as e:
        app.logger.error(f"Error adding upload to playlist: {e}")
        return jsonify({'error': 'An internal error occurred.'}), 500

@socketio.on('join_room')
def handle_join_room(data):
    room_code, username, sid = data['room_code'].upper(), data.get('username', 'Guest'), request.sid
    room_data_json = safe_redis_get(f"room:{room_code}")
    if not room_data_json: return emit('error', {'message': 'Room not found'})

    room_data = json.loads(room_data_json)
    join_room(room_code)
    is_admin = not room_data.get('admin_sid')
    if is_admin: room_data['admin_sid'] = sid
    room_data['users'][sid] = {'name': username, 'isAdmin': is_admin}

    if safe_redis_set(f"room:{room_code}", json.dumps(room_data), ex=86400):
        safe_redis_set(f"sid_to_room:{sid}", room_code, ex=86400)
        emit('load_current_state', room_data['current_state'], to=sid)
        emit('update_user_list', list(room_data['users'].values()), to=room_code)

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code, sid = data['room_code'].upper(), request.sid
    room_key = f"room:{room_code}"
    room_data_json = safe_redis_get(room_key)
    if not room_data_json: return
    room_data = json.loads(room_data_json)
    if not room_data['current_state'].get('isCollaborative', False) and room_data.get('admin_sid') != sid: return
    
    room_data['current_state'].update(data['state'])
    if safe_redis_set(room_key, json.dumps(room_data), ex=86400):
        emit('sync_player_state', room_data['current_state'], to=room_code, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    room_code = safe_redis_get(f"sid_to_room:{sid}")
    if not room_code: return
    room_key = f"room:{room_code}"
    safe_redis_delete(f"sid_to_room:{sid}")

    # Use a lock to prevent race conditions on disconnect
    with r.lock(f"lock:room:{room_code}", timeout=5):
        room_data_str = safe_redis_get(room_key)
        if not room_data_str: return
        room_data = json.loads(room_data_str)
        if sid in room_data.get('users', {}):
            del room_data['users'][sid]
            if not room_data['users']:
                safe_redis_delete(room_key)
                app.logger.info(f"Last user left. Deleting room {room_code}.")
                return
            if room_data.get('admin_sid') == sid:
                new_admin_sid = next(iter(room_data['users']))
                room_data['admin_sid'] = new_admin_sid
                room_data['users'][new_admin_sid]['isAdmin'] = True
            
            safe_redis_set(room_key, json.dumps(room_data), ex=86400)
            emit('update_user_list', list(room_data['users'].values()), to=room_code)

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s:%(message)s')
    app.logger.info("=== MoodSync API Server (Upload-Only Mode) ===")
    socketio.run(app, debug=True, host='0.0.0.0', port=5001, use_reloader=False)