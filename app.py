# moodsync/app.py

# --- 1. NO MONKEY PATCHING NEEDED AT THE TOP ---
# We are switching from eventlet to gevent, which has a different structure.

# --- 2. STANDARD LIBRARY IMPORTS ---
import os
import base64
import random
import string
import logging
import time
from logging.handlers import RotatingFileHandler

# --- 3. THIRD-PARTY LIBRARY IMPORTS ---
import requests
from flask import Flask, render_template, request, redirect, url_for
# We will use gevent as our async_mode
from flask_socketio import SocketIO, join_room, leave_room, emit, rooms as f_rooms
from dotenv import load_dotenv
from googleapiclient.discovery import build

# --- 4. APP INITIALIZATION ---
load_dotenv()

app = Flask(__name__)
app.secret_key = os.urandom(24)
# Initialize SocketIO with gevent
socketio = SocketIO(app, async_mode='gevent')

# --- 5. GLOBAL STATE & CONFIG ---
rooms = {}
class MoodSyncAPIError(Exception): pass
class PlaylistGenerationError(Exception): pass

# --- 6. HELPER FUNCTIONS ---
def setup_logging():
    if not os.path.exists('logs'): os.mkdir('logs')
    # FIX: Specify UTF-8 encoding to handle all characters
    file_handler = RotatingFileHandler('logs/moodsync.log', maxBytes=1024000, backupCount=5, encoding='utf-8')
    file_handler.setFormatter(logging.Formatter('%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'))
    if not app.debug or os.environ.get('WERKZEUG_RUN_MAIN') == 'true':
        app.logger.addHandler(file_handler)
        app.logger.setLevel(logging.INFO)

# (get_spotify_token and get_youtube_video_id are unchanged from the last correct version)
def get_spotify_token():
    try:
        client_id = os.getenv('SPOTIFY_CLIENT_ID')
        client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
        if not client_id or not client_secret: raise MoodSyncAPIError("Spotify credentials not found")
        url = "https://accounts.spotify.com/api/token"
        headers = {"Authorization": "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()}
        data = {"grant_type": "client_credentials"}
        response = requests.post(url, headers=headers, data=data)
        response.raise_for_status()
        return response.json()['access_token']
    except Exception as e:
        app.logger.error(f"Spotify token error: {e}")
        raise MoodSyncAPIError("Failed to get Spotify token")

def get_youtube_video_id(song_name, artist_name):
    youtube_api_key = os.getenv('YOUTUBE_API_KEY')
    if not youtube_api_key: return None
    try:
        youtube = build('youtube', 'v3', developerKey=youtube_api_key)
        search_query = f"{song_name} {artist_name} audio"
        search_request = youtube.search().list(q=search_query, part='snippet', maxResults=1, type='video')
        response = search_request.execute()
        if response.get('items'): return response['items'][0]['id']['videoId']
    except Exception as e:
        app.logger.error(f"YouTube search failed for '{song_name}': {e}")
    return None

def generate_playlist(mood):
    try:
        token = get_spotify_token()
        mood_genres = {
            'happy': ['pop', 'dance', 'funk', 'summer', 'happy'],
            'sad': ['acoustic', 'sad', 'indie', 'lo-fi', 'ambient'],
            'energetic': ['rock', 'electronic', 'hip-hop', 'metal', 'workout']
        }
        selected_genres = random.sample(mood_genres.get(mood, ['pop']), k=min(3, len(mood_genres.get(mood, ['pop']))))
        playlist = []
        for genre in selected_genres:
            if len(playlist) >= 10: break
            params = {"q": f"genre:{genre}", "type": "track", "limit": 15}
            headers = {"Authorization": f"Bearer {token}"}
            response = requests.get("https://api.spotify.com/v1/search", headers=headers, params=params)
            if response.status_code == 200:
                tracks = response.json().get('tracks', {}).get('items', [])
                for track in tracks:
                    if len(playlist) >= 10: break
                    song_name = track.get('name')
                    artist_name = track.get('artists', [{}])[0].get('name')
                    if not song_name or not artist_name: continue
                    video_id = get_youtube_video_id(song_name, artist_name)
                    if video_id:
                        playlist.append({
                            'name': song_name, 'artist': artist_name,
                            'albumArt': track.get('album', {}).get('images', [{}])[0].get('url') if track.get('album', {}).get('images') else None,
                            'youtubeId': video_id
                        })
        return playlist[:10]
    except Exception as e:
        app.logger.error(f"Playlist generation failed: {e}")
        raise PlaylistGenerationError("Could not generate playlist from Spotify.")

# --- 7. FLASK ROUTES ---
@app.route('/')
def home():
    return render_template('index.html')

@app.route('/generate', methods=['POST'])
def generate_route():
    try:
        mood = request.form['mood']
        playlist = generate_playlist(mood)
        if not playlist:
            raise PlaylistGenerationError("Failed to generate any playable tracks.")
        playlist_title = f"{mood.capitalize()} Vibes"
        room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        rooms[room_code] = {
            'playlist': playlist, 'title': playlist_title,
            'users': {}, 'admin_sid': None,
            'current_state': {'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'timestamp': time.time()}
        }
        app.logger.info(f"Room {room_code} created successfully.")
        return redirect(url_for('view_room', room_code=room_code))
    except Exception as e:
        app.logger.error(f"Generate route error: {e}")
        return render_template('error.html', error="Could not create a room. Please try again."), 500

@app.route('/room/<string:room_code>')
def view_room(room_code):
    room_code = room_code.upper()
    if room_code in rooms:
        return render_template('result.html', songs=rooms[room_code]['playlist'],
                               playlist_title=rooms[room_code]['title'], room_code=room_code)
    else:
        return render_template('error.html', error=f"Room '{room_code}' not found."), 404

# --- 8. SOCKET.IO EVENT HANDLERS ---
# (These handlers are correct and remain unchanged)
@socketio.on('join_room')
def handle_join_room(data):
    room_code = data['room_code'].upper()
    username = data.get('username', 'Guest')
    sid = request.sid
    if room_code not in rooms: return
    room = rooms[room_code]
    join_room(room_code)
    is_admin = not room['admin_sid']
    if is_admin: room['admin_sid'] = sid
    room['users'][sid] = {'name': username, 'isAdmin': is_admin, 'sid': sid}
    emit('load_current_state', room['current_state'], to=sid)
    emit('update_user_list', list(room['users'].values()), to=room_code)
    app.logger.info(f"'{username}' joined room '{room_code}'. Admin: {is_admin}")

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code = data['room_code'].upper()
    sid = request.sid
    if room_code in rooms:
        room = rooms[room_code]
        if room['admin_sid'] == sid:
            room['current_state'] = data['state']
            emit('sync_player_state', data['state'], to=room_code, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    for room_code, room in rooms.items():
        if sid in room['users']:
            username = room['users'][sid]['name']
            del room['users'][sid]
            if room['admin_sid'] == sid:
                room['admin_sid'] = next(iter(room['users']), {}).get('sid')
                if room['admin_sid']: room['users'][room['admin_sid']]['isAdmin'] = True
            emit('update_user_list', list(room['users'].values()), to=room_code)
            app.logger.info(f"'{username}' left room '{room_code}'")
            break

# --- 9. MAIN EXECUTION ---
if __name__ == '__main__':
    setup_logging()
    app.logger.info("Starting MoodSync server with gevent...")
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)