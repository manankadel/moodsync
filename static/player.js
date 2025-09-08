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
    
    socket.on('connect', () => {
        console.log('Connected to server');
        socket.emit('join_room', { room_code: ROOM_CODE, username: username });
    });
    
    socket.on('disconnect', () => {
        console.log('Disconnected from server');
    });
    
    socket.on('error', (data) => {
        console.error('Socket error:', data);
        alert('Error: ' + data.message);
    });
    
    socket.on('update_user_list', renderUserList);
    socket.on('load_current_state', (state) => syncPlayer(state, true));
    socket.on('sync_player_state', (state) => syncPlayer(state, false));

    // ======== YOUTUBE PLAYER ========
    window.onYouTubeIframeAPIReady = () => {
        player = new YT.Player('youtube-player', {
            height: '100', 
            width: '100',
            playerVars: { 
                'playsinline': 1, 
                'controls': 0,
                'disablekb': 1,
                'fs': 0,
                'modestbranding': 1,
                'rel': 0
            },
            events: { 
                'onReady': onPlayerReady, 
                'onStateChange': onPlayerStateChange,
                'onError': onPlayerError
            }
        });
    };

    function onPlayerReady() {
        console.log('YouTube player ready');
        if(player && typeof player.setVolume === 'function') {
            player.setVolume(volumeSlider.value);
        }
    }

    function onPlayerStateChange(event) {
        if (!isUserAdmin || isSeeking) return;
        
        console.log('Player state changed:', event.data);
        updatePlayPauseButton(event.data);
        
        if (event.data === YT.PlayerState.PLAYING) {
            startTimelineUpdater();
            startVisualizer();
        } else if (event.data === YT.PlayerState.PAUSED) {
            clearInterval(updateInterval);
        } else if (event.data === YT.PlayerState.ENDED) {
            // Auto-play next track
            const nextIndex = (currentTrackIndex + 1) % tracks.length;
            playSong(nextIndex);
            return; // Don't emit state for auto-advance
        }
        
        // Emit state with slight delay to ensure player is ready
        setTimeout(() => {
            emitPlayerState();
        }, 100);
    }

    function onPlayerError(event) {
        console.error('YouTube player error:', event.data);
        alert('Error playing video. Skipping to next track.');
        if (isUserAdmin) {
            const nextIndex = (currentTrackIndex + 1) % tracks.length;
            playSong(nextIndex);
        }
    }

    // ======== CORE LOGIC ========
    function syncPlayer(state, isFirstLoad) {
        if (!player || typeof player.seekTo !== 'function') {
            console.log('Player not ready for sync');
            return;
        }
        
        console.log('Syncing player:', state);
        isSeeking = true;
        
        const { trackIndex, currentTime, isPlaying, timestamp } = state;

        // Load new track if different
        if (currentTrackIndex !== trackIndex) {
            playSong(trackIndex, false);
        }
        
        // Calculate time drift for sync
        const timeDiff = (Date.now() / 1000) - timestamp;
        let seekTime = currentTime;
        
        // Only apply drift compensation if playing and not first load
        if (isPlaying && !isFirstLoad) {
            seekTime = Math.max(0, currentTime + timeDiff);
        }
        
        // Seek to position
        player.seekTo(seekTime, true);
        
        // Set play state
        if (isPlaying) {
            player.playVideo();
        } else {
            player.pauseVideo();
        }
        
        updatePlayPauseButton(isPlaying ? YT.PlayerState.PLAYING : YT.PlayerState.PAUSED);
        
        if (isPlaying) {
            startTimelineUpdater();
            startVisualizer();
        } else {
            clearInterval(updateInterval);
        }

        // Allow seeking again after sync
        setTimeout(() => { 
            isSeeking = false; 
        }, 500);
    }
    
    function playSong(trackIndex, shouldEmit = true) {
        const trackElement = tracks[trackIndex];
        if (!trackElement) {
            console.error('Track not found:', trackIndex);
            return;
        }

        const videoId = trackElement.dataset.youtubeId;
        if (!videoId || videoId === 'none') {
            alert("This song is not available for playback.");
            return;
        }

        console.log('Playing song:', trackIndex, trackElement.dataset.songName);
        
        currentTrackIndex = trackIndex;
        updateAllTrackPlayingStates();
        
        // Update now playing display
        nowPlayingTitle.textContent = trackElement.dataset.songName;
        nowPlayingArtist.textContent = trackElement.dataset.artistName;
        
        // Update album art with error handling
        const albumArt = trackElement.dataset.albumArt;
        if (albumArt && albumArt !== 'None') {
            playerAlbumArtImg.src = albumArt;
            playerAlbumArtImg.onerror = () => {
                playerAlbumArtImg.src = '/static/default-album-art.png'; // Fallback
            };
        }
        
        // Load the video
        player.loadVideoById(videoId);

        // Emit state if admin and should emit
        if (isUserAdmin && shouldEmit) {
            setTimeout(() => {
                emitPlayerState();
            }, 1000); // Give player time to load
        }
    }

    function emitPlayerState() {
        if (!isUserAdmin || !player || typeof player.getPlayerState !== 'function') {
            return;
        }
        
        try {
            const state = {
                isPlaying: player.getPlayerState() === YT.PlayerState.PLAYING,
                trackIndex: currentTrackIndex,
                currentTime: player.getCurrentTime() || 0,
                timestamp: Date.now() / 1000
            };
            
            console.log('Emitting player state:', state);
            socket.emit('update_player_state', { room_code: ROOM_CODE, state: state });
        } catch (error) {
            console.error('Error emitting player state:', error);
        }
    }

    // ======== UI & VISUALS ========
    function renderUserList(users) {
        console.log('Updating user list:', users);
        participantList.innerHTML = '';
        
        // Find current user and update admin status
        const currentUser = users.find(u => u.name === username);
        if (currentUser) {
            isUserAdmin = currentUser.isAdmin;
            toggleAdminControls(isUserAdmin);
            console.log('User is admin:', isUserAdmin);
        }
        
        // Render user list
        users.forEach(user => {
            const li = document.createElement('li');
            li.className = 'participant-item';
            li.innerHTML = `
                ${user.isAdmin ? '<span class="admin-icon">👑</span>' : ''} 
                <span class="participant-name">${user.name}</span>
            `;
            participantList.appendChild(li);
        });
    }

    function toggleAdminControls(isAdmin) {
        allControls.forEach(el => {
            el.disabled = !isAdmin;
            el.style.opacity = isAdmin ? '1' : '0.5';
        });
        
        // Update UI feedback
        if (isAdmin) {
            playerContainer.classList.add('admin-mode');
        } else {
            playerContainer.classList.remove('admin-mode');
        }
    }

    function updatePlayPauseButton(playerState) {
        const isPlaying = (playerState === YT.PlayerState.PLAYING);
        playPauseBtn.innerHTML = isPlaying ? pauseIconSVG : playIconSVG;
        playPauseBtn.setAttribute('aria-label', isPlaying ? 'Pause' : 'Play');
    }

    function startTimelineUpdater() {
        clearInterval(updateInterval);
        updateInterval = setInterval(() => {
            if (player && typeof player.getDuration === 'function' && !isSeeking) {
                try {
                    const currentTime = player.getCurrentTime() || 0;
                    const duration = player.getDuration() || 0;
                    
                    if (duration > 0) {
                        timelineSlider.value = (currentTime / duration) * 100;
                        currentTimeEl.textContent = formatTime(currentTime);
                        totalTimeEl.textContent = formatTime(duration);
                    }
                } catch (error) {
                    console.error('Error updating timeline:', error);
                }
            }
        }, 1000);
    }

    function formatTime(seconds) {
        if (isNaN(seconds) || seconds < 0) return '0:00';
        const min = Math.floor(seconds / 60);
        const sec = Math.floor(seconds % 60).toString().padStart(2, '0');
        return `${min}:${sec}`;
    }

    function startVisualizer() {
        if (!visualizerCanvas) return;
        
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
                const barHeight = Math.random() * visualizerCanvas.height * 0.8;
                const x = (visualizerCanvas.width / barCount) * i;
                const barWidth = (visualizerCanvas.width / barCount) - 2;
                
                // Create gradient for bars
                const gradient = ctx.createLinearGradient(0, visualizerCanvas.height, 0, visualizerCanvas.height - barHeight);
                gradient.addColorStop(0, `rgba(29, 185, 84, ${Math.random() * 0.5 + 0.5})`);
                gradient.addColorStop(1, `rgba(30, 215, 96, ${Math.random() * 0.3 + 0.7})`);
                
                ctx.fillStyle = gradient;
                ctx.fillRect(x, visualizerCanvas.height - barHeight, barWidth, barHeight);
            }
            
            visualizerAnimationId = requestAnimationFrame(animate);
        }
        animate();
    }
    
    function updateAllTrackPlayingStates() {
        tracks.forEach((track, index) => {
            track.classList.toggle('playing', index === currentTrackIndex);
        });
    }

    // ======== EVENT LISTENERS ========
    tracks.forEach((track, index) => {
        track.addEventListener('click', () => { 
            if (isUserAdmin) {
                playSong(index); 
            }
        });
    });

    playPauseBtn.addEventListener('click', () => {
        if (!isUserAdmin || !player) return;
        
        try {
            if (player.getPlayerState() === YT.PlayerState.PLAYING) {
                player.pauseVideo();
            } else {
                player.playVideo();
            }
        } catch (error) {
            console.error('Error toggling play/pause:', error);
        }
    });

    nextBtn.addEventListener('click', () => { 
        if (isUserAdmin) {
            const nextIndex = (currentTrackIndex + 1) % tracks.length;
            playSong(nextIndex); 
        }
    });
    
    prevBtn.addEventListener('click', () => { 
        if (isUserAdmin) {
            const prevIndex = (currentTrackIndex - 1 + tracks.length) % tracks.length;
            playSong(prevIndex); 
        }
    });

    // Timeline slider events
    timelineSlider.addEventListener('mousedown', () => { 
        if (isUserAdmin) {
            isSeeking = true; 
        }
    });
    
    timelineSlider.addEventListener('mouseup', () => {
        if (isUserAdmin && player) {
            try {
                const duration = player.getDuration() || 0;
                const seekTime = (timelineSlider.value / 100) * duration;
                player.seekTo(seekTime, true);
                
                setTimeout(() => {
                    isSeeking = false;
                    emitPlayerState();
                }, 200);
            } catch (error) {
                console.error('Error seeking:', error);
                isSeeking = false;
            }
        }
    });

    volumeSlider.addEventListener('input', () => {
        if (player && typeof player.setVolume === 'function') {
            try {
                player.setVolume(volumeSlider.value);
            } catch (error) {
                console.error('Error setting volume:', error);
            }
        }
    });

    // Keyboard shortcuts for admin
    document.addEventListener('keydown', (e) => {
        if (!isUserAdmin) return;
        
        switch(e.code) {
            case 'Space':
                e.preventDefault();
                playPauseBtn.click();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                prevBtn.click();
                break;
            case 'ArrowRight':
                e.preventDefault();
                nextBtn.click();
                break;
        }
    });

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => {
        clearInterval(updateInterval);
        cancelAnimationFrame(visualizerAnimationId);
        if (socket) {
            socket.disconnect();
        }
    });
});