import os
import requests
import base64
import random
import logging
import traceback
from logging.handlers import RotatingFileHandler
from datetime import datetime
from flask import Flask, render_template, request, jsonify
from dotenv import load_dotenv

# Load environment variables
load_dotenv()

# Create Flask application
app = Flask(__name__)
app.secret_key = os.urandom(24)

# Custom Exception Classes
class MoodSyncAPIError(Exception):
    """Exception raised for API-related errors"""
    pass

class PlaylistGenerationError(Exception):
    """Exception raised during playlist generation"""
    pass

# Logging Setup
def setup_logging():
    # Create logs directory if it doesn't exist
    if not os.path.exists('logs'):
        os.mkdir('logs')

    # Configure logging
    file_handler = RotatingFileHandler(
        'logs/moodsync.log', 
        maxBytes=10240, 
        backupCount=10
    )
    file_handler.setFormatter(logging.Formatter(
        '%(asctime)s %(levelname)s: %(message)s [in %(pathname)s:%(lineno)d]'
    ))
    file_handler.setLevel(logging.INFO)

    # Add handler to app logger
    app.logger.addHandler(file_handler)
    app.logger.setLevel(logging.INFO)
    app.logger.info('MoodSync Application Startup')

# Spotify Token Function
def get_spotify_token():
    """
    Retrieve Spotify API access token
    
    Returns:
        str: Access token for Spotify API
    """
    try:
        client_id = os.getenv('SPOTIFY_CLIENT_ID')
        client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
        
        if not client_id or not client_secret:
            raise MoodSyncAPIError("Spotify credentials not found")
        
        url = "https://accounts.spotify.com/api/token"
        headers = {
            "Authorization": "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode(),
            "Content-Type": "application/x-www-form-urlencoded"
        }
        data = {"grant_type": "client_credentials"}

        response = requests.post(url, headers=headers, data=data)
        response.raise_for_status()
        
        return response.json()['access_token']
    
    except requests.RequestException as e:
        app.logger.error(f"Spotify Token Request Error: {e}")
        raise MoodSyncAPIError(f"Failed to retrieve Spotify token: {e}")

# Weather Function
def get_weather(city='London'):
    """
    Retrieve current weather information
    
    Args:
        city (str): City name for weather lookup
    
    Returns:
        dict: Weather information
    """
    try:
        api_key = os.getenv('OPENWEATHERMAP_API_KEY')
        
        if not api_key:
            raise MoodSyncAPIError("OpenWeatherMap API key not found")
        
        url = f"http://api.openweathermap.org/data/2.5/weather?q={city}&appid={api_key}&units=metric"
        
        response = requests.get(url)
        response.raise_for_status()
        
        weather_data = response.json()
        return {
            'main': weather_data['weather'][0]['main'],
            'description': weather_data['weather'][0]['description'],
            'temperature': round(weather_data['main']['temp'], 1),
            'icon': weather_data['weather'][0]['icon']
        }
    
    except requests.RequestException as e:
        app.logger.warning(f"Weather API Error: {e}. Using fallback.")
        return {
            'main': 'Clear',
            'description': 'clear sky',
            'temperature': 20,
            'icon': '01d'
        }

# Playlist Generation Function
def generate_playlist(mood, weather, time_of_day):
    """
    Generate personalized playlist based on mood, weather, and time
    
    Args:
        mood (str): User's current mood
        weather (dict): Current weather information
        time_of_day (str): Time of day
    
    Returns:
        list: Curated playlist of tracks
    """
    try:
        # Validate mood
        if mood not in ['happy', 'sad', 'energetic']:
            raise ValueError("Invalid mood selection")

        # Log the start of playlist generation
        app.logger.info(f"Generating playlist - Mood: {mood}, Weather: {weather}, Time: {time_of_day}")

        token = get_spotify_token()
        
        # Enhanced genre mapping with more specific genres
        mood_genres = {
            'happy': [
                'pop', 'dance', 'funk', 
                'latin', 'disco', 'reggaeton',
                'summer hits', 'feel good'
            ],
            'sad': [
                'acoustic', 'blues', 'indie', 
                'lo-fi', 'classical', 'ambient',
                'sad songs', 'emotional'
            ],
            'energetic': [
                'rock', 'electronic', 'hip hop', 
                'metal', 'punk', 'drum and bass',
                'workout', 'motivation'
            ]
        }
        
        # Spotify API Search
        url = "https://api.spotify.com/v1/search"
        headers = {"Authorization": f"Bearer {token}"}
        
        playlist = []
        
        # Shuffle and select genres
        genres = random.sample(mood_genres.get(mood, ['pop']), k=3)
        
        for genre in genres:
            params = {
                "q": f"genre:{genre}",
                "type": "track",
                "limit": 10,  # Increased limit
                "offset": random.randint(0, 50)
            }
            
            try:
                response = requests.get(url, headers=headers, params=params)
                response.raise_for_status()
                
                tracks = response.json().get('tracks', {}).get('items', [])
                
                # Log number of tracks found
                app.logger.info(f"Tracks found for genre {genre}: {len(tracks)}")
                
                # Add unique tracks
                for track in tracks:
                    # Check if track is already in playlist
                    if track['id'] not in [p.get('id') for p in playlist]:
                        playlist.append({
                            'id': track['id'],
                            'name': track.get('name', 'Unknown Track'),
                            'artists': track.get('artists', [{'name': 'Unknown Artist'}]),
                            'album': track.get('album', {}),
                            'external_urls': track.get('external_urls', {'spotify': '#'})
                        })
                    
                    # Break if we have 10 tracks
                    if len(playlist) >= 10:
                        break
            
            except requests.RequestException as e:
                app.logger.error(f"Error fetching tracks for genre {genre}: {e}")
                continue
        
        # If not enough tracks, add fallback
        while len(playlist) < 10:
            playlist.append({
                'id': f'fallback_{len(playlist)}',
                'name': 'Mood Booster Track',
                'artists': [{'name': 'MoodSync'}],
                'album': {},
                'external_urls': {'spotify': '#'}
            })
        
        # Log final playlist
        app.logger.info(f"Generated playlist with {len(playlist)} tracks")
        
        return playlist[:10]
    
    except Exception as e:
        # Log the full error details
        app.logger.error(f"Playlist Generation Error: {e}")
        app.logger.error(f"Traceback: {traceback.format_exc()}")
        raise PlaylistGenerationError(f"Failed to generate playlist: {e}")

# Routes
@app.route('/')
def home():
    """Render home page"""
    return render_template('index.html')

@app.route('/generate', methods=['POST'])
def generate():
    """Generate personalized playlist"""
    try:
        # Get user inputs
        mood = request.form['mood']
        hour = int(request.form['hour'])
        
        # Log incoming request
        app.logger.info(f"Playlist generation request - Mood: {mood}, Hour: {hour}")
        
        # Validate inputs
        if not mood or mood not in ['happy', 'sad', 'energetic']:
            raise ValueError("Invalid mood selection")
        
        # Determine time of day
        if 5 <= hour < 12:
            time_of_day = 'morning'
        elif 12 <= hour < 17:
            time_of_day = 'afternoon'
        elif 17 <= hour < 21:
            time_of_day = 'evening'
        else:
            time_of_day = 'night'
        
        # Get weather
        weather = get_weather()
        
        # Generate playlist
        playlist = generate_playlist(mood, weather, time_of_day)
        
        # Create playlist title
        playlist_title = f"{mood.capitalize()} {weather['main']} {time_of_day.capitalize()} Vibes"
        
        return render_template('result.html', 
                               songs=playlist, 
                               playlist_title=playlist_title,
                               weather=weather)
    
    except ValueError as ve:
        app.logger.warning(f"Validation Error: {str(ve)}")
        return render_template('error.html', 
            error="Please select a valid mood."
        ), 400
    except PlaylistGenerationError as pge:
        app.logger.error(f"Playlist Generation Error: {str(pge)}")
        return render_template('error.html', 
            error="We couldn't generate your playlist. Please try a different mood or check your connection."
        ), 500
    except Exception as e:
        # Log the error
        app.logger.error(f"Unexpected Error in Playlist Generation: {str(e)}")
        app.logger.error(f"Traceback: {traceback.format_exc()}")
        return render_template('error.html', 
            error="An unexpected error occurred. Our team has been notified."
        ), 500

# Error Handlers
@app.errorhandler(MoodSyncAPIError)
def handle_api_error(error):
    app.logger.error(f"API Error: {str(error)}")
    return render_template('error.html', 
        error="We're having trouble connecting to our music services. Please try again later."
    ), 500

@app.errorhandler(PlaylistGenerationError)
def handle_playlist_error(error):
    app.logger.error(f"Playlist Generation Error: {str(error)}")
    return render_template('error.html', 
        error="We couldn't generate your playlist. Please select a different mood."
    ), 500

@app.errorhandler(Exception)
def handle_unexpected_error(error):
    # Log the full traceback
    app.logger.error(
        f"Unexpected Error: {str(error)}\n"
        f"Traceback: {traceback.format_exc()}"
    )
    return render_template('error.html', 
        error="An unexpected error occurred. Our team has been notified."
    ), 500

# Application Startup
if __name__ == '__main__':
    # Setup logging before running
    setup_logging()
    
    # Run the application
    app.run(
        debug=True, 
        host='0.0.0.0',  # Make accessible on all network interfaces
        port=5000
    )