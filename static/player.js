// static/player.js

document.addEventListener('DOMContentLoaded', () => {
    const roomDataDiv = document.getElementById('room-data');
    if (!roomDataDiv) return;

    // ======== STATE & CONFIG ========
    const ROOM_CODE = roomDataDiv.dataset.roomCode;
    let player;
    let updateInterval;
    let visualizerAnimationId;
    let username = '';
    let isUserAdmin = false;
    let isSeeking = false;
    let currentTrackIndex = -1;
    const tracks = Array.from(document.querySelectorAll('.track'));

    // ======== DOM ELEMENTS ========
    const participantList = document.getElementById('participant-list');
    const allControls = document.querySelectorAll('.control-btn, .slider');
    const playerContainer = document.getElementById('player-container');
    const nowPlayingTitle = document.getElementById('now-playing-title');
    const nowPlayingArtist = document.getElementById('now-playing-artist');
    const playerAlbumArtImg = document.querySelector('#player-album-art img');
    const playPauseBtn = document.getElementById('play-pause-btn');
    const nextBtn = document.getElementById('next-btn');
    const prevBtn = document.getElementById('prev-btn');
    const timelineSlider = document.getElementById('timeline-slider');
    const currentTimeEl = document.getElementById('current-time');
    const totalTimeEl = document.getElementById('total-time');
    const volumeSlider = document.getElementById('volume-slider');
    const visualizerCanvas = document.getElementById('player-visualizer-canvas');
    const playIconSVG = `<svg role="img" height="24" width="24" aria-hidden="true" viewBox="0 0 24 24"><path d="M7.05 3.606a.75.75 0 0 1 .591.905l-1.282 5.599a.75.75 0 0 1-1.442-.315L6.2 4.094a.75.75 0 0 1 .85-.488zM9.533 3.692a.75.75 0 0 1 .728.843l-1.282 5.599a.75.75 0 0 1-1.442-.315L8.81 4.22a.75.75 0 0 1 .723-.528zM12.016 3.69a.75.75 0 0 1 .727.845l-1.282 5.599a.75.75 0 0 1-1.442-.315L11.29 4.22a.75.75 0 0 1 .726-.53zM14.5 3.694a.75.75 0 0 1 .726.845l-1.282 5.599a.75.75 0 1 1-1.442-.315L13.77 4.22a.75.75 0 0 1 .73-.527zM16.983 3.69a.75.75 0 0 1 .727.845l-1.282 5.599a.75.75 0 1 1-1.442-.315L16.26 4.22a.75.75 0 0 1 .723-.53z"></path></svg>`;
    const pauseIconSVG = `<svg role="img" height="24" width="24" aria-hidden="true" viewBox="0 0 24 24"><path d="M5.7 3a.7.7 0 0 0-.7.7v16.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7H5.7zm10 0a.7.7 0 0 0-.7.7v16.6a.7.7 0 0 0 .7.7h2.6a.7.7 0 0 0 .7-.7V3.7a.7.7 0 0 0-.7-.7h-2.6z"></path></svg>`;

    // ======== INITIALIZATION ========
    function init() {
        username = prompt("Please enter your name:", "Guest") || "Guest";
        allControls.forEach(el => el.disabled = true);
        playPauseBtn.innerHTML = playIconSVG;
    }
    init();

    // ======== SOCKET.IO ========
    const socket = io();
    socket.on('connect', () => socket.emit('join_room', { room_code: ROOM_CODE, username: username }));
    socket.on('update_user_list', renderUserList);
    socket.on('load_current_state', (state) => syncPlayer(state, true));
    socket.on('sync_player_state', (state) => syncPlayer(state, false));

    // ======== YOUTUBE PLAYER ========
    window.onYouTubeIframeAPIReady = () => {
        player = new YT.Player('youtube-player', {
            height: '100', width: '100',
            playerVars: { 'playsinline': 1, 'controls': 0 },
            events: { 'onReady': onPlayerReady, 'onStateChange': onPlayerStateChange }
        });
    };

    function onPlayerReady() {
        if(player && typeof player.setVolume === 'function') {
            player.setVolume(volumeSlider.value);
        }
    }

    function onPlayerStateChange(event) {
        if (!isUserAdmin || isSeeking) return;
        updatePlayPauseButton(event.data);
        if (event.data === YT.PlayerState.PLAYING) {
            startTimelineUpdater();
            startVisualizer();
        } else {
            clearInterval(updateInterval);
        }
        emitPlayerState();
    }

    // ======== CORE LOGIC ========
    function syncPlayer(state, isFirstLoad) {
        if (!player || typeof player.seekTo !== 'function') return;
        isSeeking = true;
        const { trackIndex, currentTime, isPlaying, timestamp } = state;

        if (currentTrackIndex !== trackIndex) {
            playSong(trackIndex, false);
        }
        
        const timeDiff = (Date.now() / 1000) - timestamp; // JS equivalent of time.time()
        let seekTime = isFirstLoad && isPlaying ? (currentTime + timeDiff) : currentTime;
        
        player.seekTo(seekTime, true);
        
        if (isPlaying) player.playVideo(); else player.pauseVideo();
        
        updatePlayPauseButton(isPlaying ? 1 : 2);
        if(isPlaying) startTimelineUpdater(); else clearInterval(updateInterval);
        if(isPlaying) startVisualizer();

        setTimeout(() => { isSeeking = false; }, 800);
    }
    
    function playSong(trackIndex, shouldEmit = true) {
        const trackElement = tracks[trackIndex];
        if (!trackElement) return;

        const videoId = trackElement.dataset.youtubeId;
        if (!videoId || videoId === 'none') {
            alert("This song is not available for playback.");
            return;
        }

        currentTrackIndex = trackIndex;
        updateAllTrackPlayingStates();
        
        nowPlayingTitle.textContent = trackElement.dataset.songName;
        nowPlayingArtist.textContent = trackElement.dataset.artistName;
        playerAlbumArtImg.src = trackElement.dataset.albumArt;
        
        player.loadVideoById(videoId);

        if (isUserAdmin && shouldEmit) {
            setTimeout(emitPlayerState, 500);
        }
    }

    function emitPlayerState() {
        if (!isUserAdmin || !player || typeof player.getPlayerState !== 'function') return;
        const state = {
            isPlaying: player.getPlayerState() === YT.PlayerState.PLAYING,
            trackIndex: currentTrackIndex,
            currentTime: player.getCurrentTime(),
            timestamp: Date.now() / 1000 // JS equivalent of time.time()
        };
        socket.emit('update_player_state', { room_code: ROOM_CODE, state: state });
    }

    // ======== UI & VISUALS ========
    function renderUserList(users) {
        participantList.innerHTML = '';
        const me = users.find(u => u.sid === socket.id);
        if(me) {
            isUserAdmin = me.isAdmin;
            toggleAdminControls(isUserAdmin);
        }
        users.forEach(user => {
            const li = document.createElement('li');
            li.innerHTML = `${user.isAdmin ? '<span class="admin-icon">👑</span>' : ''} ${user.name}`;
            participantList.appendChild(li);
        });
    }

    function toggleAdminControls(isAdmin) {
        allControls.forEach(el => el.disabled = !isAdmin);
    }

    function updatePlayPauseButton(playerState) {
        playPauseBtn.innerHTML = (playerState === YT.PlayerState.PLAYING) ? pauseIconSVG : playIconSVG;
    }

    function startTimelineUpdater() {
        clearInterval(updateInterval);
        updateInterval = setInterval(() => {
            if (player && typeof player.getDuration === 'function' && !isSeeking) {
                const currentTime = player.getCurrentTime();
                const duration = player.getDuration();
                if (duration > 0) {
                    timelineSlider.value = (currentTime / duration) * 100;
                    currentTimeEl.textContent = formatTime(currentTime);
                    totalTimeEl.textContent = formatTime(duration);
                }
            }
        }, 1000);
    }

    function formatTime(seconds) {
        const min = Math.floor(seconds / 60);
        const sec = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${min}:${sec}`;
    }

    function startVisualizer() {
        cancelAnimationFrame(visualizerAnimationId);
        const ctx = visualizerCanvas.getContext('2d');
        const barCount = 16;
        
        function animate() {
            if (!player || player.getPlayerState() !== YT.PlayerState.PLAYING) {
                ctx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
                visualizerAnimationId = requestAnimationFrame(animate);
                return;
            }
            ctx.clearRect(0, 0, visualizerCanvas.width, visualizerCanvas.height);
            for (let i = 0; i < barCount; i++) {
                const barHeight = Math.random() * visualizerCanvas.height;
                const x = (visualizerCanvas.width / barCount) * i;
                const barWidth = (visualizerCanvas.width / barCount) - 2;
                ctx.fillStyle = `rgba(0, 242, 96, ${Math.random() * 0.7 + 0.2})`;
                ctx.fillRect(x, visualizerCanvas.height - barHeight, barWidth, barHeight);
            }
            visualizerAnimationId = requestAnimationFrame(animate);
        }
        animate();
    }
    
    function updateAllTrackPlayingStates() {
        tracks.forEach((t, i) => t.classList.toggle('playing', i === currentTrackIndex));
    }

    // ======== EVENT LISTENERS ========
    tracks.forEach((track, index) => {
        track.addEventListener('click', () => { if(isUserAdmin) playSong(index); });
    });

    playPauseBtn.addEventListener('click', () => {
        if(!isUserAdmin) return;
        if (player.getPlayerState() === YT.PlayerState.PLAYING) player.pauseVideo(); else player.playVideo();
    });

    nextBtn.addEventListener('click', () => { if(isUserAdmin) playSong((currentTrackIndex + 1) % tracks.length); });
    prevBtn.addEventListener('click', () => { if(isUserAdmin) playSong((currentTrackIndex - 1 + tracks.length) % tracks.length); });

    timelineSlider.addEventListener('mousedown', () => { if(isUserAdmin) isSeeking = true; });
    timelineSlider.addEventListener('change', () => {
        if(isUserAdmin) {
            const duration = player.getDuration();
            player.seekTo((timelineSlider.value / 100) * duration, true);
            isSeeking = false;
            emitPlayerState();
        }
    });

    volumeSlider.addEventListener('input', () => {
        if(player && typeof player.setVolume === 'function') {
            player.setVolume(volumeSlider.value);
        }
    });
});