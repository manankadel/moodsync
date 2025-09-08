# test_parse_lyrics.py - Test the parse_lyrics function
from lrc_kit.lrc import parse_lyrics

# Test with a popular song
test_video_id = "4NRXx6U8ABQ"  # Blinding Lights by The Weeknd
youtube_url = f"https://www.youtube.com/watch?v={test_video_id}"

print(f"=== Testing parse_lyrics with {youtube_url} ===")

try:
    result = parse_lyrics(youtube_url)
    print(f"Type of result: {type(result)}")
    print(f"Result: {result}")
    
    if result:
        if isinstance(result, list):
            print(f"Result is a list with {len(result)} items")
            if len(result) > 0:
                print(f"First item: {result[0]}")
                print(f"First item type: {type(result[0])}")
        elif isinstance(result, dict):
            print(f"Result is a dict with keys: {result.keys()}")
        elif isinstance(result, str):
            print(f"Result is a string of length {len(result)}")
            print(f"First 200 chars: {result[:200]}")
        else:
            print(f"Result has attributes: {dir(result)}")
    else:
        print("Result is None or empty")
        
except Exception as e:
    print(f"Error: {e}")
    import traceback
    traceback.print_exc()

print("=== Test complete ===")