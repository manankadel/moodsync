import requests
import base64
import os
from dotenv import load_dotenv

load_dotenv()

client_id = os.getenv('SPOTIFY_CLIENT_ID')
client_secret = os.getenv('SPOTIFY_CLIENT_SECRET')

url = "https://accounts.spotify.com/api/token"
headers = {
    "Authorization": "Basic " + base64.b64encode(f"{client_id}:{client_secret}".encode()).decode(),
    "Content-Type": "application/x-www-form-urlencoded"
}
data = {"grant_type": "client_credentials"}

response = requests.post(url, headers=headers, data=data)
print(response.json())