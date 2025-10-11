import os, random, string, logging, time, json
from flask import Flask, jsonify, request, send_from_directory, url_for
from flask_socketio import SocketIO, join_room, emit
from flask_cors import CORS
from dotenv import load_dotenv
import redis
from werkzeug.utils import secure_filename
from werkzeug.middleware.proxy_fix import ProxyFix

load_dotenv()
app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_for=1, x_proto=1, x_host=1, x_prefix=1)

# --- CONFIGURATION ---
CORS(app, origins=os.getenv("FRONTEND_URL", "http://localhost:3000"), supports_credentials=True)
socketio = SocketIO(app, cors_allowed_origins=os.getenv("FRONTEND_URL", "http://localhost:3000"), async_mode='gevent')

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)
app.config['UPLOAD_FOLDER'] = UPLOAD_FOLDER
app.config['MAX_CONTENT_LENGTH'] = 50 * 1024 * 1024

def allowed_file(filename):
    return '.' in filename and filename.rsplit('.', 1)[1].lower() in {'mp3', 'wav', 'ogg', 'm4a', 'flac'}

try:
    redis_url = os.getenv('REDIS_URL')
    if not redis_url: raise ValueError("REDIS_URL env var not set.")
    r = redis.from_url(redis_url, decode_responses=True)
    r.ping()
    app.logger.info("Redis connection successful.")
except Exception as e:
    app.logger.error(f"FATAL: Redis connection failed: {e}"); exit(1)

def safe_get(key): return r.get(key)
def safe_set(key, value, ex): r.set(key, value, ex=ex)
def safe_delete(key): r.delete(key)

@app.route('/ping', methods=['GET'])
def ping_pong():
    return jsonify({'serverTime': time.time()})

@app.route('/generate', methods=['POST'])
def generate_route():
    while True:
        room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        if not r.exists(f"room:{room_code}"): break

    # THIS IS THE CRITICAL FIX: The placeholder now has the same "shape" as a real song object.
    placeholder_playlist = [{'name': "Your Playlist is Empty", 'artist': "Upload a track to begin!", 'isUpload': False, 'audioUrl': None, 'albumArt': None}]
    room_data = {
        'playlist': placeholder_playlist, 
        'title': "Shared Sonic Space", 
        'users': {}, 
        'admin_sid': None, 
        'current_state': {'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'volume': 80, 'equalizer': {'bass': 0, 'mids': 0, 'treble': 0}, 'isCollaborative': True, 'serverTimestamp': time.time()}
    }
    safe_set(f"room:{room_code}", json.dumps(room_data), ex=86400)
    return jsonify({'room_code': room_code})

@app.route('/api/room/<string:room_code>')
def get_room_data(room_code):
    room_data_json = safe_get(f"room:{room_code.upper()}")
    if not room_data_json: return jsonify({'error': 'Room not found'}), 404
    return jsonify(json.loads(room_data_json))

@app.route('/uploads/<path:filename>')
def serve_uploaded_file(filename):
    return send_from_directory(os.path.abspath(UPLOAD_FOLDER), secure_filename(filename))

@app.route('/api/upload-local', methods=['POST'])
def upload_file_local():
    if 'file' not in request.files or not allowed_file(request.files['file'].filename): return jsonify({'error': 'Invalid file'}), 400
    file = request.files['file']
    filename = f"{os.urandom(8).hex()}_{secure_filename(file.filename)}"
    try:
        file.save(os.path.join(UPLOAD_FOLDER, filename))
        audio_url = url_for('serve_uploaded_file', filename=filename, _external=True, _scheme=request.scheme)
        return jsonify({'audioUrl': audio_url}), 200
    except Exception as e:
        app.logger.error(f"Local file save error: {e}")
        return jsonify({'error': 'Failed to save file'}), 500

@app.route('/api/room/<string:room_code>/add-upload', methods=['POST'])
def add_upload_to_playlist(room_code):
    room_key, data = f"room:{room_code.upper()}", request.get_json()
    with r.lock(f"lock:{room_key}", timeout=5):
        room_data = json.loads(safe_get(room_key) or '{}')
        if not room_data: return jsonify({'error': 'Room not found'}), 404
        new_track = {'name': data.get('title'), 'artist': data.get('artist'), 'isUpload': True, 'audioUrl': data.get('audioUrl'), 'albumArt': None}
        is_first = not any(t.get('audioUrl') for t in room_data['playlist'])
        if is_first:
            room_data['playlist'] = [new_track]
            room_data['current_state'].update({'trackIndex': 0, 'currentTime': 0, 'isPlaying': True})
        else:
            room_data['playlist'].append(new_track)
        safe_set(room_key, json.dumps(room_data), ex=86400)
        socketio.emit('refresh_playlist', room_data, to=room_code.upper())
        if is_first: socketio.emit('sync_player_state', room_data['current_state'], to=room_code.upper())
    return jsonify({'message': 'Track added'}), 200

@socketio.on('join_room')
def handle_join_room(data):
    room_code, username, sid = data['room_code'].upper(), data.get('username', 'Guest'), request.sid
    room_key = f"room:{room_code}"
    with r.lock(f"lock:{room_key}", timeout=5):
        room_data_json = safe_get(room_key)
        if not room_data_json: return emit('error', {'message': 'Room not found'})
        room_data = json.loads(room_data_json)
        join_room(room_code)
        is_admin = not room_data.get('admin_sid')
        if is_admin: room_data['admin_sid'] = sid
        room_data['users'][sid] = {'name': username, 'isAdmin': is_admin}
        if safe_set(room_key, json.dumps(room_data), ex=86400):
            r.set(f"sid_to_room:{sid}", room_code, ex=86400)
            emit('load_current_state', room_data['current_state'], to=sid)
            emit('update_user_list', list(room_data['users'].values()), to=room_code)

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code, sid = data['room_code'].upper(), request.sid
    room_key = f"room:{room_code}"
    with r.lock(f"lock:{room_key}", timeout=2):
        room_data_json = safe_get(room_key)
        if not room_data_json: return
        room_data = json.loads(room_data_json)
        if not room_data['current_state'].get('isCollaborative', False) and room_data.get('admin_sid') != sid: return
        room_data['current_state'].update(data['state'])
        if safe_set(room_key, json.dumps(room_data), ex=86400):
            emit('sync_player_state', room_data['current_state'], to=room_code, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    room_code = safe_get(f"sid_to_room:{sid}")
    if not room_code: return
    room_key = f"room:{room_code}"
    safe_delete(f"sid_to_room:{sid}")
    with r.lock(f"lock:{room_key}", timeout=5):
        room_data_json = safe_get(room_key)
        if not room_data_json: return
        room_data = json.loads(room_data_json)
        if sid in room_data.get('users', {}):
            del room_data['users'][sid]
            if not room_data['users']: return safe_delete(room_key)
            if room_data.get('admin_sid') == sid:
                new_admin_sid = next(iter(room_data['users']))
                room_data['admin_sid'] = new_admin_sid
                room_data['users'][new_admin_sid]['isAdmin'] = True
            safe_set(room_key, json.dumps(room_data), ex=86400)
            emit('update_user_list', list(room_data['users'].values()), to=room_code)

if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s:%(message)s')
    socketio.run(app, debug=True, host='0.0.0.0', port=5001)