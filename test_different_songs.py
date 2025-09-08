# test_different_songs.py - Test lyrics with different popular songs
from lrc_kit.lrc import parse_lyrics

# Test with multiple popular songs
test_songs = [
    {"id": "4NRXx6U8ABQ", "name": "Blinding Lights - The Weeknd"},
    {"id": "H5v3kku4y6Q", "name": "As It Was - Harry Styles"},
    {"id": "JGwWNGJdvx8", "name": "Shape of You - Ed Sheeran"},
    {"id": "hT_nvWreIhg", "name": "Counting Stars - OneRepublic"},
    {"id": "kJQP7kiw5Fk", "name": "Despacito - Luis Fonsi"},
]

for song in test_songs:
    video_id = song["id"]
    name = song["name"]
    youtube_url = f"https://www.youtube.com/watch?v={video_id}"
    
    print(f"\n=== Testing: {name} ===")
    print(f"URL: {youtube_url}")
    
    try:
        result = parse_lyrics(youtube_url)
        print(f"Type: {type(result)}")
        
        if isinstance(result, tuple) and len(result) >= 2:
            lyrics_list, metadata = result
            print(f"Lyrics count: {len(lyrics_list)}")
            print(f"Metadata: {metadata}")
            
            if lyrics_list:
                print("✅ Found lyrics!")
                print(f"First few lines:")
                for i, line in enumerate(lyrics_list[:3]):
                    print(f"  {i+1}. {line}")
                break  # Stop at first successful result
            else:
                print("❌ Empty lyrics list")
        else:
            print(f"❌ Unexpected result format: {result}")
            
    except Exception as e:
        print(f"❌ Error: {e}")

print("\n=== Test complete ===")