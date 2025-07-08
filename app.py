# moodsync/app.py

# --- 1. IMPORTS ---
import os, base64, random, string, logging, time, requests
from concurrent.futures import ThreadPoolExecutor
from flask import Flask, render_template, request, redirect, url_for
from flask_socketio import SocketIO, join_room, leave_room, emit
from dotenv import load_dotenv
from googleapiclient.discovery import build

# --- 2. APP INITIALIZATION ---
load_dotenv()
app = Flask(__name__)
app.secret_key = os.urandom(24)
socketio = SocketIO(app, async_mode='threading') # Using standard threading is most reliable

# --- 3. GLOBAL STATE & CONFIG ---
rooms = {}
class MoodSyncAPIError(Exception): pass
class PlaylistGenerationError(Exception): pass
logging.basicConfig(level=logging.INFO, format='%(asctime)s %(levelname)s: %(message)s')

# --- 4. HELPER FUNCTIONS ---
def get_spotify_token():
    client_id = os.getenv('SPOTIFY_CLIENT_ID')
    client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
    if not client_id or not client_secret:
        app.logger.error("Spotify keys not found.")
        return None
    try:
        url = "https://accounts.spotify.com/api/token"
        headers = {"Authorization": "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()}
        data = {"grant_type": "client_credentials"}
        response = requests.post(url, headers=headers, data=data)
        response.raise_for_status()
        return response.json()['access_token']
    except Exception as e:
        app.logger.error(f"Spotify token request error: {e}")
        return None

def get_youtube_video_id(song_name, artist_name):
    youtube_api_key = os.getenv('YOUTUBE_API_KEY')
    if not youtube_api_key: return None
    try:
        youtube = build('youtube', 'v3', developerKey=youtube_api_key)
        search_request = youtube.search().list(q=f"{song_name} {artist_name} audio", part='snippet', maxResults=1, type='video')
        response = search_request.execute()
        if response.get('items'):
            return response['items'][0]['id']['videoId']
    except Exception as e:
        app.logger.warning(f"YouTube search failed for '{song_name}': {e}")
    return None

def generate_playlist(mood):
    token = get_spotify_token()
    if not token:
        raise PlaylistGenerationError("Could not get Spotify token.")
    
    mood_genres = {'happy': ['pop', 'dance', 'funk'], 'sad': ['acoustic', 'sad', 'lo-fi'], 'energetic': ['rock', 'electronic', 'hip-hop']}
    selected_genres = random.sample(mood_genres.get(mood, ['pop']), k=min(2, len(mood_genres.get(mood, ['pop']))))
    
    candidate_tracks = []
    headers = {"Authorization": f"Bearer {token}"}
    for genre in selected_genres:
        params = {"q": f"genre:{genre}", "type": "track", "limit": 25}
        response = requests.get("https://api.spotify.com/v1/search", headers=headers, params=params)
        if response.status_code == 200:
            candidate_tracks.extend(response.json().get('tracks', {}).get('items', []))

    if not candidate_tracks:
        raise PlaylistGenerationError("Spotify returned no tracks.")
    random.shuffle(candidate_tracks)

    playlist = []
    tasks = []
    with ThreadPoolExecutor(max_workers=10) as executor:
        for track in candidate_tracks:
            song_name, artist_name = track.get('name'), track.get('artists', [{}])[0].get('name')
            if song_name and artist_name:
                future = executor.submit(get_youtube_video_id, song_name, artist_name)
                tasks.append((future, track))

        for future, track in tasks:
            if len(playlist) >= 10: break
            
            # --- THIS IS THE FIX ---
            # Corrected the variable name from video__id to video_id
            video_id = future.result() 

            if video_id:
                album_art = track.get('album', {}).get('images', [{}])[0].get('url') if track.get('album', {}).get('images') else None
                playlist.append({
                    'name': track.get('name'), 'artist': track.get('artists', [{}])[0].get('name'),
                    'albumArt': album_art, 'youtubeId': video_id
                })
    return playlist

# --- 5. FLASK ROUTES & SOCKETIO HANDLERS ---
@app.route('/')
def home():
    return render_template('index.html')

@app.route('/generate', methods=['POST'])
def generate_route():
    try:
        mood = request.form['mood']
        app.logger.info(f"Generating '{mood}' playlist...")
        start_time = time.time()
        playlist = generate_playlist(mood)
        app.logger.info(f"Playlist generation took {time.time() - start_time:.2f} seconds.")
        if not playlist:
            raise PlaylistGenerationError("Failed to generate any playable tracks.")
        room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        rooms[room_code] = {'playlist': playlist, 'title': f"{mood.capitalize()} Vibes", 'users': {}, 'admin_sid': None, 'current_state': {'isPlaying': False, 'trackIndex': 0, 'currentTime': 0, 'timestamp': time.time()}}
        app.logger.info(f"Room {room_code} created.")
        return redirect(url_for('view_room', room_code=room_code))
    except Exception as e:
        app.logger.error(f"Generate route error: {e}")
        return render_template('error.html', error="Could not create a room. Please try again."), 500

@app.route('/room/<string:room_code>')
def view_room(room_code):
    room_data = rooms.get(room_code.upper())
    if room_data:
        return render_template('result.html', songs=room_data['playlist'], playlist_title=room_data['title'], room_code=room_code.upper())
    return render_template('error.html', error=f"Room '{room_code}' not found."), 404

# (The rest of the socketio handlers are correct and do not need changes)
@socketio.on('join_room')
def handle_join_room(data):
    room_code, username, sid = data['room_code'].upper(), data.get('username', 'Guest'), request.sid
    if room_code not in rooms: return
    room = rooms[room_code]
    join_room(room_code)
    is_admin = not room['admin_sid']
    if is_admin: room['admin_sid'] = sid
    room['users'][sid] = {'name': username, 'isAdmin': is_admin, 'sid': sid}
    emit('load_current_state', room['current_state'], to=sid)
    emit('update_user_list', list(room['users'].values()), to=room_code)

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code, sid = data['room_code'].upper(), request.sid
    if room_code in rooms and rooms[room_code]['admin_sid'] == sid:
        rooms[room_code]['current_state'] = data['state']
        emit('sync_player_state', data['state'], to=room_code, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    for room_code, room in rooms.items():
        if sid in room['users']:
            del room['users'][sid]
            if room['admin_sid'] == sid:
                room['admin_sid'] = next(iter(room['users']), {}).get('sid')
                if room['admin_sid']: room['users'][room['admin_sid']]['isAdmin'] = True
            emit('update_user_list', list(room['users'].values()), to=room_code)
            break

# --- 6. MAIN EXECUTION ---
if __name__ == '__main__':
    app.logger.info("Starting MoodSync server for local development...")
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)