import os
import time
import json
import uuid
from datetime import datetime
from flask import Flask, request, send_from_directory, jsonify
from flask_cors import CORS
from flask_socketio import SocketIO, emit, join_room, leave_room
import redis
# --------------------- CONFIG ---------------------

UPLOAD_FOLDER = 'uploads'
os.makedirs(UPLOAD_FOLDER, exist_ok=True)

# Allowed origins (Vercel prod + wildcard + localhost)
ALLOWED_ORIGINS = [
    "https://www.moodsync.fun",
    "https://moodsync.fun",
    "https://moodsync-lime.vercel.app",
    "https://moodsync-1c2ygszwn-bluebloods-projects-89f081fb.vercel.app",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "*"
]

app = Flask(__name__)
CORS(app, resources={r"/*": {"origins": ALLOWED_ORIGINS}})

socketio = SocketIO(
    app,
    cors_allowed_origins=ALLOWED_ORIGINS,
    async_mode='threading',
    ping_timeout=25,
    ping_interval=10
)
# ------------------- REDIS ------------------------

REDIS_URL = os.getenv("REDIS_URL", "redis://red-d2vev2be5dus73fkp14g:6379")
r = redis.from_url(REDIS_URL, decode_responses=True)
# ----------------- HELPERS ------------------------

def now_ms():
    return int(time.time() * 1000)

def room_key(room):
    return f"room:{room}"

def get_room(room):
    data = r.get(room_key(room))
    return json.loads(data) if data else None

def save_room(room, data):
    r.set(room_key(room), json.dumps(data))
# ------------------ ROOM STATE MODEL ------------------

def create_room_state(room):
    return {
        "room": room,
        "createdAt": now_ms(),
        "members": [],
        "currentTrack": None,   # { url, duration }
        "status": "idle",       # idle | playing | paused
        "startAt": None,        # global timestamp when playback starts
        "pausedAt": None,       # ms into track when paused
        "updatedAt": now_ms()
    }


def ensure_room(room):
    state = get_room(room)
    if not state:
        state = create_room_state(room)
        save_room(room, state)
    return state


def update_room(room, updates: dict):
    state = ensure_room(room)
    state.update(updates)
    state["updatedAt"] = now_ms()
    save_room(room, state)
    return state
# ----------------------- JOIN / LEAVE -----------------------

@socketio.on("join_room")
def on_join(data):
    room = data.get("room")
    user = data.get("user")

    if not room or not user:
        return
    
    state = ensure_room(room)
    if user not in state["members"]:
        state["members"].append(user)
    
    save_room(room, state)
    join_room(room)

    emit("room_update", state, to=room)


@socketio.on("leave_room")
def on_leave(data):
    room = data.get("room")
    user = data.get("user")

    if not room or not user:
        return
    
    state = ensure_room(room)
    if user in state["members"]:
        state["members"].remove(user)

    save_room(room, state)
    leave_room(room)

    emit("room_update", state, to=room)
# ------------------ CLOCK SYNC ------------------

@socketio.on("clock_sync_request")
def on_clock_sync(msg):
    t1 = msg.get("t1", now_ms())
    serverTime = now_ms()
    emit("clock_sync_response", {
        "t1": t1,
        "serverTime": serverTime
    })
# ------------------ HEARTBEAT ------------------

@socketio.on("heartbeat")
def on_heartbeat(data):
    room = data.get("room")
    if room:
        emit("heartbeat_ack", {"time": now_ms()}, room=room)
# ------------------ PLAYBACK CONTROL ------------------

@socketio.on("play_track")
def on_play(data):
    room = data.get("room")
    url = data.get("url")
    duration = data.get("duration", None)

    if not room or not url:
        return

    startAt = now_ms() + 1200  # schedule 1.2 sec ahead for clients to buffer

    state = update_room(room, {
        "currentTrack": {
            "url": url,
            "duration": duration
        },
        "status": "playing",
        "startAt": startAt,
        "pausedAt": None
    })

    emit("play", {
        "url": url,
        "startAt": startAt,
        "duration": duration
    }, to=room)

    emit("room_update", state, to=room)
# --------------------- PAUSE ---------------------

@socketio.on("pause_track")
def on_pause(data):
    room = data.get("room")
    pausedAt = data.get("pausedAt")  # ms into track when paused

    if not room:
        return

    state = update_room(room, {
        "status": "paused",
        "pausedAt": pausedAt,
        "startAt": None
    })

    emit("pause", {"pausedAt": pausedAt}, to=room)
    emit("room_update", state, to=room)
# --------------------- RESUME ---------------------

@socketio.on("resume_track")
def on_resume(data):
    room = data.get("room")
    pausedAt = data.get("pausedAt")

    if not room:
        return

    startAt = now_ms() + 1000

    state = update_room(room, {
        "status": "playing",
        "startAt": startAt,
        "pausedAt": None
    })

    emit("resume", {
        "startAt": startAt,
        "pausedAt": pausedAt
    }, to=room)

    emit("room_update", state, to=room)
# ---------------------- SEEK ----------------------

@socketio.on("seek_track")
def on_seek(data):
    room = data.get("room")
    position = data.get("position")  # ms into track

    if not room:
        return

    startAt = now_ms() + 800

    state = update_room(room, {
        "status": "playing",
        "startAt": startAt,
        "pausedAt": None
    })

    emit("seek", {
        "startAt": startAt,
        "position": position
    }, to=room)

    emit("room_update", state, to=room)
# ------------------ SERVE UPLOADED AUDIO ------------------

@app.route('/uploads/<path:filename>')
def serve_upload(filename):
    return send_from_directory(UPLOAD_FOLDER, filename, as_attachment=False)
# ------------------ ROOM STATE API ------------------

@app.route('/api/room/<room>')
def api_room(room):
    return jsonify(get_room(room) or {})
# ------------------ HEALTH CHECK ------------------

@app.route('/healthz')
def health():
    return jsonify({"status": "ok", "time": now_ms()})
# ------------------ MAIN ENTRY ------------------

if __name__ == "__main__":
    port = int(os.getenv("PORT", 8000))
    socketio.run(
        app,
        host="0.0.0.0",
        port=port,
        debug=False
    )
