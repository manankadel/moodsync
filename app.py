# moodsync/app.py - Fixed Version with No Recursion Issues

import os, base64, random, string, logging, time, requests
from functools import lru_cache
from flask import Flask, render_template, request, redirect, url_for, jsonify
from flask_socketio import SocketIO, join_room, emit
from dotenv import load_dotenv
from googleapiclient.discovery import build

# --- APP INITIALIZATION ---
load_dotenv()
app = Flask(__name__)
app.secret_key = os.urandom(24)
socketio = SocketIO(app, cors_allowed_origins="*")

# --- GLOBAL STATE & CONFIG ---
rooms = {}
spotify_token_cache = {'token': None, 'expires': 0}
youtube_cache = {}  # Cache YouTube searches to save quota

# Circuit breaker for Spotify token failures
token_failure_count = 0
last_token_failure = 0

# --- MOOD CONFIGURATIONS ---
# Using valid Spotify seed genres only
MOOD_CONFIGS = {
    'happy': {
        'seeds': ['pop', 'dance', 'funk', 'disco'],
        'attributes': {'valence': 0.7, 'energy': 0.6, 'danceability': 0.7}
    },
    'sad': {
        'seeds': ['acoustic', 'indie', 'alternative', 'blues'],
        'attributes': {'valence': 0.3, 'energy': 0.4, 'acousticness': 0.7}
    },
    'energetic': {
        'seeds': ['rock', 'electronic', 'hip-hop', 'dance'],
        'attributes': {'energy': 0.8, 'danceability': 0.6, 'tempo': 120}
    },
    'chill': {
        'seeds': ['ambient', 'jazz', 'indie', 'acoustic'],
        'attributes': {'valence': 0.5, 'energy': 0.4, 'acousticness': 0.6}
    }
}

# --- SPOTIFY FUNCTIONS ---
@lru_cache(maxsize=1)
def get_spotify_credentials():
    """Cache Spotify credentials"""
    return os.getenv('SPOTIFY_CLIENT_ID'), os.getenv('SPOTIFY_CLIENT_SECRET')

def get_spotify_token():
    """Get cached Spotify token or fetch new one with circuit breaker"""
    global token_failure_count, last_token_failure
    
    # Circuit breaker: if we've failed recently, don't try again immediately
    if token_failure_count >= 3 and time.time() - last_token_failure < 300:  # 5 minute cooldown
        app.logger.warning("Spotify token circuit breaker active - too many recent failures")
        return None
    
    # Check if we have a valid cached token
    if time.time() < spotify_token_cache['expires'] and spotify_token_cache['token']:
        return spotify_token_cache['token']
    
    client_id, client_secret = get_spotify_credentials()
    if not client_id or not client_secret:
        app.logger.error("Spotify credentials missing from environment variables")
        return None
    
    try:
        # Create base64 encoded auth string
        auth_str = base64.b64encode(f"{client_id}:{client_secret}".encode()).decode()
        
        # Make token request
        response = requests.post(
            "https://accounts.spotify.com/api/token",
            headers={
                "Authorization": f"Basic {auth_str}",
                "Content-Type": "application/x-www-form-urlencoded"
            },
            data={"grant_type": "client_credentials"},
            timeout=10
        )
        
        # Check if request was successful
        if response.status_code != 200:
            app.logger.error(f"Spotify token request failed: {response.status_code} - {response.text}")
            token_failure_count += 1
            last_token_failure = time.time()
            return None
        
        data = response.json()
        
        # Validate response has required fields
        if 'access_token' not in data:
            app.logger.error(f"Invalid token response: {data}")
            token_failure_count += 1
            last_token_failure = time.time()
            return None
        
        # Cache the token
        spotify_token_cache['token'] = data['access_token']
        spotify_token_cache['expires'] = time.time() + data.get('expires_in', 3600) - 60  # 60s buffer
        
        # Reset failure count on success
        token_failure_count = 0
        
        app.logger.info("Successfully obtained Spotify token")
        return data['access_token']
        
    except requests.exceptions.RequestException as e:
        app.logger.error(f"Spotify token request exception: {e}")
        token_failure_count += 1
        last_token_failure = time.time()
        return None
    except Exception as e:
        app.logger.error(f"Unexpected error getting Spotify token: {e}")
        token_failure_count += 1
        last_token_failure = time.time()
        return None

def get_spotify_recommendations(mood, limit=15):
    """Get Spotify recommendations using seed genres and audio features"""
    token = get_spotify_token()
    if not token:
        app.logger.error("No Spotify token available for recommendations")
        return []
    
    config = MOOD_CONFIGS.get(mood, MOOD_CONFIGS['happy'])
    seed_genres = random.sample(config['seeds'], min(2, len(config['seeds'])))
    
    params = {
        'seed_genres': ','.join(seed_genres),
        'limit': limit,
        'market': 'US'
    }
    
    # Add audio feature targets (only include valid ones)
    for attr, value in config['attributes'].items():
        if attr in ['valence', 'energy', 'danceability', 'acousticness']:
            params[f'target_{attr}'] = value
        elif attr == 'tempo':
            params[f'min_{attr}'] = value
    
    try:
        response = requests.get(
            "https://api.spotify.com/v1/recommendations",
            headers={"Authorization": f"Bearer {token}"},
            params=params,
            timeout=10
        )
        response.raise_for_status()
        tracks = response.json().get('tracks', [])
        app.logger.info(f"Got {len(tracks)} tracks from Spotify recommendations")
        return tracks
    except Exception as e:
        app.logger.error(f"Spotify recommendations error: {e}")
        # Fallback: try with just one genre - PASS THE TOKEN TO AVOID RECURSION
        app.logger.info("Trying fallback search with existing token")
        return get_spotify_fallback(mood, token, limit)

def get_spotify_fallback(mood, token, limit=15):
    """Fallback method using search instead of recommendations - USES PROVIDED TOKEN"""
    if not token:
        app.logger.error("No token provided to fallback function")
        return []
        
    try:
        config = MOOD_CONFIGS.get(mood, MOOD_CONFIGS['happy'])
        genre = random.choice(config['seeds'])
        
        # Search for tracks in the genre
        search_params = {
            'q': f'genre:{genre}',
            'type': 'track',
            'limit': limit,
            'market': 'US'
        }
        
        response = requests.get(
            "https://api.spotify.com/v1/search",
            headers={"Authorization": f"Bearer {token}"},
            params=search_params,
            timeout=10
        )
        response.raise_for_status()
        tracks = response.json().get('tracks', {}).get('items', [])
        app.logger.info(f"Got {len(tracks)} tracks from Spotify fallback search")
        return tracks
    except Exception as e:
        app.logger.error(f"Spotify fallback error: {e}")
        return []

def get_simple_spotify_search(mood):
    """Simple search fallback when recommendations fail - GET TOKEN ONCE"""
    token = get_spotify_token()
    if not token:
        app.logger.error("No Spotify token available for simple search")
        return []
    
    # Simple mood-based search queries
    search_queries = {
        'happy': ['happy songs', 'upbeat music', 'feel good'],
        'sad': ['sad songs', 'melancholy', 'emotional'],
        'energetic': ['workout music', 'pump up', 'high energy'],
        'chill': ['chill music', 'relaxing', 'calm']
    }
    
    queries = search_queries.get(mood, ['popular music'])
    all_tracks = []
    
    for query in queries:
        try:
            response = requests.get(
                "https://api.spotify.com/v1/search",
                headers={"Authorization": f"Bearer {token}"},
                params={
                    'q': query,
                    'type': 'track',
                    'limit': 10,
                    'market': 'US'
                },
                timeout=10
            )
            response.raise_for_status()
            tracks = response.json().get('tracks', {}).get('items', [])
            all_tracks.extend(tracks)
            app.logger.info(f"Simple search '{query}' returned {len(tracks)} tracks")
        except Exception as e:
            app.logger.error(f"Search query '{query}' failed: {e}")
            continue
    
    app.logger.info(f"Simple search returned {len(all_tracks)} total tracks")
    return all_tracks

# --- YOUTUBE FUNCTIONS ---
def get_youtube_video_id(song_name, artist_name):
    """Get YouTube video ID with caching to save quota"""
    cache_key = f"{song_name}_{artist_name}".lower()
    
    # Check cache first
    if cache_key in youtube_cache:
        return youtube_cache[cache_key]
    
    youtube_api_key = os.getenv('YOUTUBE_API_KEY')
    if not youtube_api_key:
        app.logger.warning("YouTube API key not found in environment variables")
        return None
    
    try:
        youtube = build('youtube', 'v3', developerKey=youtube_api_key)
        search_query = f"{song_name} {artist_name} official audio"
        
        search_request = youtube.search().list(
            q=search_query,
            part='snippet',
            maxResults=1,
            type='video',
            videoCategoryId='10'  # Music category
        )
        
        response = search_request.execute()
        video_id = None
        
        if response.get('items'):
            video_id = response['items'][0]['id']['videoId']
            app.logger.debug(f"Found YouTube video for '{song_name}' by '{artist_name}': {video_id}")
        else:
            app.logger.debug(f"No YouTube video found for '{song_name}' by '{artist_name}'")
        
        # Cache result (even if None) to avoid repeated API calls
        youtube_cache[cache_key] = video_id
        return video_id
        
    except Exception as e:
        app.logger.warning(f"YouTube search failed for '{song_name}' by '{artist_name}': {e}")
        youtube_cache[cache_key] = None
        return None

# --- PLAYLIST GENERATION ---
def generate_playlist(mood):
    """Generate optimized playlist with minimal YouTube API calls - IMPROVED ERROR HANDLING"""
    app.logger.info(f"Starting playlist generation for mood: {mood}")
    
    # Get Spotify recommendations
    tracks = get_spotify_recommendations(mood, limit=20)
    
    # If no tracks, try a simple search approach
    if not tracks:
        app.logger.warning("No tracks from recommendations, trying simple search...")
        tracks = get_simple_spotify_search(mood)
    
    if not tracks:
        app.logger.error("No tracks found from any Spotify method")
        raise Exception("No tracks found from Spotify")
    
    app.logger.info(f"Found {len(tracks)} tracks from Spotify")
    
    # Sort by popularity to prioritize likely-to-exist YouTube videos
    tracks.sort(key=lambda x: x.get('popularity', 0), reverse=True)
    
    playlist = []
    youtube_calls = 0
    max_youtube_calls = 15  # Limit YouTube API calls
    
    for track in tracks:
        if len(playlist) >= 10:  # Target playlist size
            break
            
        song_name = track.get('name')
        artist_name = track.get('artists', [{}])[0].get('name')
        
        if not song_name or not artist_name:
            app.logger.debug(f"Skipping track with missing name or artist: {track}")
            continue
        
        # Check cache first, then make API call if needed
        cache_key = f"{song_name}_{artist_name}".lower()
        video_id = youtube_cache.get(cache_key)
        
        if video_id is None and youtube_calls < max_youtube_calls:
            video_id = get_youtube_video_id(song_name, artist_name)
            youtube_calls += 1
        
        if video_id:
            album_art = None
            if track.get('album', {}).get('images'):
                album_art = track['album']['images'][0]['url']
            
            playlist.append({
                'name': song_name,
                'artist': artist_name,
                'albumArt': album_art,
                'youtubeId': video_id,
                'duration': track.get('duration_ms', 0) // 1000,
                'popularity': track.get('popularity', 0)
            })
            
            app.logger.debug(f"Added to playlist: '{song_name}' by '{artist_name}'")
    
    app.logger.info(f"Generated playlist with {len(playlist)} tracks using {youtube_calls} YouTube API calls")
    
    if not playlist:
        app.logger.error("No valid tracks found after YouTube processing")
        raise Exception("No valid tracks found after YouTube processing")
        
    return playlist

# --- ROUTES ---
@app.route('/')
def home():
    return render_template('index.html')

@app.route('/generate', methods=['POST'])
def generate_route():
    try:
        mood = request.form.get('mood', 'happy').lower()
        if mood not in MOOD_CONFIGS:
            app.logger.warning(f"Invalid mood '{mood}' provided, defaulting to 'happy'")
            mood = 'happy'
        
        app.logger.info(f"Generating playlist for mood: {mood}")
        start_time = time.time()
        playlist = generate_playlist(mood)
        generation_time = time.time() - start_time
        
        if not playlist:
            raise Exception("Failed to generate playlist")
        
        room_code = ''.join(random.choices(string.ascii_uppercase + string.digits, k=6))
        rooms[room_code] = {
            'playlist': playlist,
            'title': f"{mood.capitalize()} Vibes",
            'users': {},
            'admin_sid': None,
            'current_state': {
                'isPlaying': False,
                'trackIndex': 0,
                'currentTime': 0,
                'timestamp': time.time()
            },
            'created_at': time.time()
        }
        
        app.logger.info(f"Room {room_code} created successfully in {generation_time:.2f}s with {len(playlist)} tracks")
        return redirect(url_for('view_room', room_code=room_code))
        
    except Exception as e:
        app.logger.error(f"Generate error: {e}")
        return render_template('error.html', error="Could not create playlist. Please try again later."), 500

@app.route('/room/<string:room_code>')
def view_room(room_code):
    room_code = room_code.upper()
    room_data = rooms.get(room_code)
    
    if not room_data:
        app.logger.warning(f"Room '{room_code}' not found")
        return render_template('error.html', error=f"Room '{room_code}' not found."), 404
    
    app.logger.info(f"Serving room {room_code} with {len(room_data['playlist'])} tracks")
    return render_template('result.html', 
                         songs=room_data['playlist'], 
                         playlist_title=room_data['title'], 
                         room_code=room_code)

@app.route('/api/room/<string:room_code>/info')
def room_info(room_code):
    """API endpoint for room info"""
    room_data = rooms.get(room_code.upper())
    if not room_data:
        return jsonify({'error': 'Room not found'}), 404
    
    return jsonify({
        'playlist_title': room_data['title'],
        'track_count': len(room_data['playlist']),
        'user_count': len(room_data['users'])
    })

# --- SOCKETIO HANDLERS ---
@socketio.on('join_room')
def handle_join_room(data):
    room_code = data['room_code'].upper()
    username = data.get('username', 'Guest')
    sid = request.sid
    
    if room_code not in rooms:
        emit('error', {'message': 'Room not found'})
        return
    
    room = rooms[room_code]
    join_room(room_code)
    
    # Set admin if first user
    is_admin = not room['admin_sid']
    if is_admin:
        room['admin_sid'] = sid
    
    room['users'][sid] = {
        'name': username,
        'isAdmin': is_admin,
        'sid': sid,
        'joined_at': time.time()
    }
    
    emit('load_current_state', room['current_state'], to=sid)
    emit('update_user_list', list(room['users'].values()), to=room_code)
    
    app.logger.info(f"User {username} joined room {room_code} (admin: {is_admin})")

@socketio.on('update_player_state')
def handle_player_state_update(data):
    room_code = data['room_code'].upper()
    sid = request.sid
    
    if room_code not in rooms:
        return
    
    room = rooms[room_code]
    if room['admin_sid'] != sid:
        return
    
    # Update room state
    room['current_state'] = data['state']
    room['current_state']['timestamp'] = time.time()
    
    # Broadcast to all users except admin
    emit('sync_player_state', data['state'], to=room_code, include_self=False)

@socketio.on('disconnect')
def handle_disconnect():
    sid = request.sid
    
    for room_code, room in rooms.items():
        if sid in room['users']:
            user_name = room['users'][sid]['name']
            del room['users'][sid]
            
            # Transfer admin if needed
            if room['admin_sid'] == sid:
                if room['users']:
                    new_admin_sid = next(iter(room['users']))
                    room['admin_sid'] = new_admin_sid
                    room['users'][new_admin_sid]['isAdmin'] = True
                    app.logger.info(f"Admin transferred to {room['users'][new_admin_sid]['name']} in room {room_code}")
                else:
                    room['admin_sid'] = None
                    app.logger.info(f"Room {room_code} now has no admin")
            
            emit('update_user_list', list(room['users'].values()), to=room_code)
            app.logger.info(f"User {user_name} disconnected from room {room_code}")
            break

# --- CLEANUP TASK ---
def cleanup_old_rooms():
    """Remove rooms older than 24 hours"""
    current_time = time.time()
    old_rooms = [code for code, room in rooms.items() 
                 if current_time - room.get('created_at', 0) > 86400]
    
    for code in old_rooms:
        del rooms[code]
    
    if old_rooms:
        app.logger.info(f"Cleaned up {len(old_rooms)} old rooms")

# --- MAIN ---
if __name__ == '__main__':
    # Set up logging
    logging.basicConfig(
        level=logging.INFO, 
        format='%(asctime)s %(levelname)s: %(message)s',
        handlers=[
            logging.StreamHandler(),
            logging.FileHandler('moodsync.log')
        ]
    )
    
    # Log startup info
    app.logger.info("=== Starting MoodSync Server ===")
    app.logger.info(f"Spotify Client ID: {'✓' if os.getenv('SPOTIFY_CLIENT_ID') else '✗'}")
    app.logger.info(f"Spotify Client Secret: {'✓' if os.getenv('SPOTIFY_CLIENT_SECRET') else '✗'}")
    app.logger.info(f"YouTube API Key: {'✓' if os.getenv('YOUTUBE_API_KEY') else '✗'}")
    
    # Start server
    socketio.run(app, debug=True, host='0.0.0.0', port=5000)