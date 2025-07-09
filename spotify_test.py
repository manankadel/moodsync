# spotify_debug_test.py
import os
import base64
import requests
from dotenv import load_dotenv

load_dotenv()

def test_spotify_connection():
    """Test Spotify API connection and search functionality"""
    client_id = os.getenv('SPOTIFY_CLIENT_ID')
    client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')
    
    print("=== SPOTIFY API DEBUG TEST ===")
    print(f"Client ID: {client_id[:10]}..." if client_id else "Client ID: NOT FOUND")
    print(f"Client Secret: {client_secret[:10]}..." if client_secret else "Client Secret: NOT FOUND")
    
    if not client_id or not client_secret:
        print("❌ ERROR: Spotify credentials not found in .env file")
        return False
    
    # Test 1: Get access token
    print("\n1. Testing token generation...")
    try:
        url = "https://accounts.spotify.com/api/token"
        headers = {
            "Authorization": "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode(),
            "Content-Type": "application/x-www-form-urlencoded"
        }
        data = {"grant_type": "client_credentials"}
        
        response = requests.post(url, headers=headers, data=data, timeout=10)
        print(f"Token response status: {response.status_code}")
        
        if response.status_code == 200:
            token_data = response.json()
            access_token = token_data.get('access_token')
            print("✅ Token generation successful")
            print(f"Token: {access_token[:20]}...")
        else:
            print(f"❌ Token generation failed: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Token generation error: {e}")
        return False
    
    # Test 2: Simple search test
    print("\n2. Testing basic search...")
    try:
        search_url = "https://api.spotify.com/v1/search"
        headers = {"Authorization": f"Bearer {access_token}"}
        
        # Test with simple query
        params = {
            "q": "rock",
            "type": "track",
            "limit": 5
        }
        
        response = requests.get(search_url, headers=headers, params=params, timeout=10)
        print(f"Search response status: {response.status_code}")
        
        if response.status_code == 200:
            search_data = response.json()
            tracks = search_data.get('tracks', {}).get('items', [])
            print(f"✅ Search successful - found {len(tracks)} tracks")
            
            for i, track in enumerate(tracks[:3]):
                print(f"  {i+1}. {track.get('name')} by {track.get('artists', [{}])[0].get('name')}")
                
        else:
            print(f"❌ Search failed: {response.text}")
            return False
            
    except Exception as e:
        print(f"❌ Search error: {e}")
        return False
    
    # Test 3: Genre-based search (like in your app)
    print("\n3. Testing genre-based search...")
    try:
        test_genres = ['rock', 'pop', 'electronic']
        
        for genre in test_genres:
            params = {
                "q": f"genre:{genre}",
                "type": "track",
                "limit": 5,
                "market": "US"
            }
            
            response = requests.get(search_url, headers=headers, params=params, timeout=10)
            
            if response.status_code == 200:
                search_data = response.json()
                tracks = search_data.get('tracks', {}).get('items', [])
                print(f"✅ Genre '{genre}' search: {len(tracks)} tracks found")
                
                if tracks:
                    track = tracks[0]
                    print(f"  Sample: {track.get('name')} by {track.get('artists', [{}])[0].get('name')}")
                else:
                    print(f"  ⚠️ No tracks found for genre: {genre}")
            else:
                print(f"❌ Genre '{genre}' search failed: {response.status_code}")
                
    except Exception as e:
        print(f"❌ Genre search error: {e}")
        return False
    
    print("\n=== TEST COMPLETED ===")
    return True

if __name__ == "__main__":
    test_spotify_connection()